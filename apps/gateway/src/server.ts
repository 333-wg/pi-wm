import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { routeSkills } from './skill-router.js';
import { isTeamLaunch, teamCommandGoal } from './team-launch-runtime.js';
import { EvaluationError } from '@wuming/evaluation';
import {
  MAX_SUBAGENT_DEPTH,
  OrchestratorError,
  SessionOrchestrator,
  type SqliteOrchestratorStore,
  type StoredSessionEvent,
} from '@wuming/orchestrator';
import {
  clampModelThinkingLevel,
  type Capability,
  type ArtifactRef,
  ClientMessageSchema,
  type Command,
  type CommandResult,
  type DurableEvent,
  type EvaluationDataset,
  type EvaluationGrader,
  type ExecutionEnvironment,
  type GitDiff,
  type GitStatus,
  GitActionSchema,
  type GitAction,
  type GitActionResult,
  type GitDetails,
  type ModelMetadata,
  type CustomModelApi,
  type CustomModelCandidate,
  type CustomModelConfig,
  type CustomModelConnection,
  type CustomModelService,
  type CustomModelSettings,
  type MediaModelConfig,
  type ModelRef,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProgressEvent,
  type RunEvaluation,
  type SessionSnapshot,
  type TerminalClientMessage,
  type ToolStatus,
  type WorkspaceDirectory,
  type WorkspaceFileView,
  type WorkspaceSearch,
  type WorkspaceSummary,
  ServerMessageSchema,
} from '@wuming/protocol';
import { Compile } from 'typebox/compile';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { GatewayAuth, GatewayPrincipal, GatewayPermission } from './auth.js';
import { hasGatewayPermission, tokenFromProtocols } from './auth.js';
import type { TerminalManager } from './terminal.js';
import type { SkillCatalog } from './skills.js';
import type { SkillManager } from './skill-manager.js';
import type { FileMcpCatalog } from './mcp.js';
import type { StructuredLogger } from '@wuming/orchestrator';
import type { GatewayToolCatalog } from './tools.js';
import type { MediaModelRegistry } from './media-models.js';
import type { WindowsComputerManager } from '@wuming/sandbox';
import type { OfficialAccountManager } from '@wuming/pi-adapter';

const checkClientMessage = Compile(ClientMessageSchema);
const checkServerMessage = Compile(ServerMessageSchema);
const checkGitAction = Compile(GitActionSchema);

interface ConnectionState {
  ws: WebSocket;
  local: boolean;
  principal: GatewayPrincipal;
  connectionId: string;
  hello: boolean;
  taskNotifications?: boolean;
  attachedSessions: Set<string>;
  terminalUnsubscribers: Set<() => void>;
}

export interface ApprovalResponder {
  respond(input: {
    principalId: string;
    idempotencyKey: string;
    sessionId: string;
    approvalId: string;
    decision: 'approve' | 'deny';
  }): Promise<Extract<CommandResult, { type: 'approval.accepted' }>>;
}

export interface GatewayArtifactService {
  create(input: {
    workspaceId: string;
    ownerId: string;
    name: string;
    suppliedMimeType?: string;
    content: Buffer;
  }): Promise<{ ref: ArtifactRef }>;
  read(id: string): Promise<{
    record: { ref: ArtifactRef; workspaceId: string };
    content: Buffer;
  }>;
  get(id: string): { ref: ArtifactRef; workspaceId: string } | undefined;
  assertReference(ref: ArtifactRef, workspaceId: string): unknown;
}

export interface GatewayCustomModelService {
  listMedia?(): CustomModelSettings[];
  resolveMedia?(config: MediaModelConfig): MediaModelConfig;
  list(): ModelMetadata[];
  services(): CustomModelService[];
  get(model: ModelRef): CustomModelSettings;
  discover(
    connection: CustomModelConnection
  ): Promise<{
    provider: string;
    baseUrl: string;
    api: CustomModelApi;
    models: CustomModelCandidate[];
    latencyMs: number;
  }>;
  refreshService(
    provider: string
  ): Promise<{
    provider: string;
    baseUrl: string;
    api: CustomModelApi;
    models: CustomModelCandidate[];
    latencyMs: number;
  }>;
  removeService(provider: string): Promise<void>;
  set(config: CustomModelConfig): Promise<ModelMetadata>;
  remove(model: ModelRef): Promise<void>;
  test(model: ModelRef): Promise<number>;
}

export interface GatewayWorkspaceService {
  listDirectory(workspaceId: string, path: string): Promise<WorkspaceDirectory>;
  searchFiles(workspaceId: string, query: string, limit: number): Promise<WorkspaceSearch>;
  readFile(workspaceId: string, path: string): Promise<WorkspaceFileView>;
  gitStatus(workspaceId: string): Promise<GitStatus>;
  gitDiff(workspaceId: string, path: string | undefined, staged: boolean): Promise<GitDiff>;
  gitDetails?(workspaceId: string): Promise<GitDetails>;
  gitAction?(workspaceId: string, action: GitAction): Promise<GitActionResult>;
}

export interface GatewayProjectService {
  openFolder?(ownerId: string, projectId: string): Promise<void>;
  pick(ownerId: string, kind?: 'file' | 'directory'): Promise<WorkspaceSummary>;
  create(ownerId: string, name: string): Promise<WorkspaceSummary>;
  writeFile(ownerId: string, projectId: string, path: string, content: Buffer): Promise<void>;
  complete(ownerId: string, projectId: string): Promise<WorkspaceSummary>;
  rename(ownerId: string, projectId: string, name: string): Promise<WorkspaceSummary>;
  remove(ownerId: string, projectId: string): Promise<void>;
}

export interface GatewayEvaluationService {
  listDatasets(workspaceId: string): EvaluationDataset[];
  createDataset(input: {
    principalId: string;
    idempotencyKey: string;
    workspaceId: string;
    name: string;
    graders: EvaluationGrader[];
  }): Extract<CommandResult, { type: 'evaluation.dataset.created' }>;
  deleteDataset(input: {
    principalId: string;
    idempotencyKey: string;
    workspaceId: string;
    datasetId: string;
  }): Extract<CommandResult, { type: 'evaluation.dataset.deleted' }>;
  evaluate(input: {
    principalId: string;
    idempotencyKey: string;
    snapshot: SessionSnapshot;
    runId: string;
    trajectory: ReturnType<SqliteOrchestratorStore['trajectoryReport']>;
    datasetId?: string;
    name?: string;
    graders?: EvaluationGrader[];
  }): Promise<Extract<CommandResult, { type: 'session.run.evaluated' }>>;
  listEvaluations(sessionId: string, runId: string, limit?: number): RunEvaluation[];
  attest(input: {
    principalId: string;
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    evaluationId: string;
  }): Extract<CommandResult, { type: 'session.run.attested' }>;
}

import type { AgentTeamService } from './agent-teams.js';

export interface GatewayServerOptions {
  teams?: AgentTeamService;
  auth: GatewayAuth;
  orchestrator: SessionOrchestrator;
  store: SqliteOrchestratorStore;
  approvals?: ApprovalResponder;
  artifacts?: GatewayArtifactService;
  workspace?: GatewayWorkspaceService;
  projects?: GatewayProjectService;
  evaluation?: GatewayEvaluationService;
  skills?: SkillCatalog;
  skillManagement?: (workspaceId: string) => SkillManager;
  autoRouteSkills?: boolean;
  mcp?: FileMcpCatalog;
  tools?: GatewayToolCatalog;
  computer?: Pick<WindowsComputerManager, 'status' | 'refresh' | 'setEnabled' | 'stop' | 'install'>;
  workspacePath?: (workspaceId: string) => string;
  terminal?: TerminalManager;
  maxArtifactBytes?: number;
  models?: ModelMetadata[];
  customModels?: GatewayCustomModelService;
  officialAccounts?: OfficialAccountManager;
  mediaModels?: MediaModelRegistry;
  capabilities?: Capability[];
  executionEnvironment?: ExecutionEnvironment;
  allowedOrigins?: string[];
  strictLoopbackHost?: boolean;
  maxPayloadBytes?: number;
  clock?: () => number;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
  logger?: StructuredLogger;
}

function rejectUpgrade(socket: Duplex, status: number, label: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function protocolError(error: unknown): ProtocolError {
  const explicitCode =
    error && typeof error === 'object' && 'protocolCode' in error
      ? (error as { protocolCode?: ProtocolError['code'] }).protocolCode
      : undefined;
  if (explicitCode) {
    return {
      code: explicitCode,
      message: error instanceof Error ? error.message : explicitCode,
      retryable: false,
    };
  }
  if (error instanceof OrchestratorError) {
    const code =
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'idempotency_conflict' ||
            error.code === 'conflict' ||
            error.code.includes('lease')
          ? 'conflict'
          : error.code === 'corrupt_storage'
            ? 'internal_error'
            : error.code === 'budget_exceeded'
              ? 'budget_exceeded'
              : 'internal_error';
    return { code, message: error.message, retryable: code === 'conflict' };
  }
  if (error instanceof EvaluationError) {
    const code =
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'conflict'
          ? 'conflict'
          : 'internal_error';
    return { code, message: error.message, retryable: code === 'conflict' };
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'approval_denied'
  ) {
    return {
      code: 'conflict',
      message: error instanceof Error ? error.message : 'Approval denied',
      retryable: false,
    };
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const artifactCode = (error as { code?: string }).code;
    if (['not_found', 'forbidden', 'invalid', 'too_large'].includes(artifactCode ?? '')) {
      return {
        code:
          artifactCode === 'not_found'
            ? 'not_found'
            : artifactCode === 'forbidden'
              ? 'forbidden'
              : 'invalid_request',
        message: error instanceof Error ? error.message : 'Invalid artifact',
        retryable: false,
      };
    }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : 'Internal error',
    retryable: false,
  };
}

export class GatewayServer implements AsyncDisposable {
  readonly #auth: GatewayAuth;
  readonly #orchestrator: SessionOrchestrator;
  readonly #store: SqliteOrchestratorStore;
  readonly #teams: AgentTeamService | undefined;
  readonly #approvals: ApprovalResponder | undefined;
  readonly #artifacts: GatewayArtifactService | undefined;
  readonly #workspace: GatewayWorkspaceService | undefined;
  readonly #projects: GatewayProjectService | undefined;
  readonly #evaluation: GatewayEvaluationService | undefined;
  readonly #skills: SkillCatalog | undefined;
  readonly #skillManagement: ((workspaceId: string) => SkillManager) | undefined;
  readonly #autoRouteSkills: boolean;
  readonly #mcp: FileMcpCatalog | undefined;
  readonly #tools: GatewayToolCatalog | undefined;
  readonly #computer: GatewayServerOptions['computer'];
  readonly #workspacePath: ((workspaceId: string) => string) | undefined;
  readonly #terminal: TerminalManager | undefined;
  readonly #maxArtifactBytes: number;
  readonly #models: ModelMetadata[];
  readonly #customModels: GatewayCustomModelService | undefined;
  readonly #officialAccounts: OfficialAccountManager | undefined;
  readonly #mediaModels: MediaModelRegistry | undefined;
  readonly #capabilities: Capability[];
  readonly #executionEnvironment: ExecutionEnvironment;
  readonly #allowedOrigins: Set<string>;
  readonly #strictLoopbackHost: boolean;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #onError: (error: unknown) => void;
  readonly #logger: StructuredLogger;
  readonly #http: HttpServer;
  #shuttingDown = false;
  #activeRequests = 0;

  get activeRequestCount(): number {
    return this.#activeRequests;
  }
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<ConnectionState>();
  readonly #unsubscribeStore: () => void;
  readonly #unsubscribeProgress: () => void;

  constructor(options: GatewayServerOptions) {
    this.#auth = options.auth;
    this.#orchestrator = options.orchestrator;
    this.#store = options.store;
    this.#teams = options.teams;
    this.#approvals = options.approvals;
    this.#artifacts = options.artifacts;
    this.#workspace = options.workspace;
    this.#projects = options.projects;
    this.#evaluation = options.evaluation;
    this.#skills = options.skills;
    this.#skillManagement = options.skillManagement;
    this.#autoRouteSkills = options.autoRouteSkills ?? false;
    this.#mcp = options.mcp;
    this.#tools = options.tools;
    this.#computer = options.computer;
    this.#workspacePath = options.workspacePath;
    this.#terminal = options.terminal;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? 10 * 1024 * 1024;
    this.#models = options.models ?? [];
    this.#customModels = options.customModels;
    this.#officialAccounts = options.officialAccounts;
    this.#mediaModels = options.mediaModels;
    this.#capabilities = options.capabilities ?? [
      ...(options.mediaModels ? (['model.media'] satisfies Capability[]) : []),
      'session.resume',
      'session.fork',
      'subagents',
      'goals',
      'automations',
      'turn.steer',
      'turn.follow_up',
      ...(options.approvals ? (['approval'] satisfies Capability[]) : []),
      ...(options.artifacts ? (['artifact', 'image_input'] satisfies Capability[]) : []),
      ...(options.terminal ? (['terminal'] satisfies Capability[]) : []),
      ...(options.evaluation ? (['evaluation'] satisfies Capability[]) : []),
    ];
    for (const capability of ['session.search', 'task.notifications'] as const) {
      if (!this.#capabilities.includes(capability)) this.#capabilities = [...this.#capabilities, capability];
    }
    if (options.teams && !this.#capabilities.includes('agent.teams')) this.#capabilities = [...this.#capabilities, 'agent.teams'];
    this.#executionEnvironment = options.executionEnvironment ?? {
      placement: 'server',
      processMode: 'disabled',
      terminalMode: options.terminal ? 'host' : 'disabled',
      previewEnabled: false,
      platform: process.platform,
      shell:
        process.platform === 'win32'
          ? (process.env.ComSpec ?? 'cmd.exe')
          : (process.env.SHELL ?? '/bin/sh'),
    };
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#strictLoopbackHost = options.strictLoopbackHost ?? false;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onError = options.onError ?? (() => {});
    this.#logger = options.logger ?? { log: () => {} };
    this.#http = createServer((request, response) => {
      this.#activeRequests++;
      void this.#httpRequest(request, response).finally(() => { this.#activeRequests--; });
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes ?? 1024 * 1024,
      handleProtocols: (protocols) => (protocols.has('wuming.v1') ? 'wuming.v1' : false),
    });
    this.#http.on('upgrade', (request, socket, head) => {
      void this.#upgrade(request, socket, head);
    });
    this.#unsubscribeStore = this.#store.subscribeEvents((stored) =>
      this.#broadcastStoredEvent(stored)
    );
    this.#unsubscribeProgress = this.#orchestrator.subscribeProgress((event) => {
      const goalEvent = this.#goalProgressEvent(event);
      for (const connection of this.#connections) {
        if (connection.hello && connection.attachedSessions.has(event.sessionId)) {
          this.#send(connection, { type: 'progress', event });
        }
        if (goalEvent && connection.hello && connection.attachedSessions.has(goalEvent.sessionId)) {
          this.#send(connection, { type: 'progress', event: goalEvent });
        }
      }
    });
  }

  async #httpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#shuttingDown) return this.#json(response, 503, { error: 'Server shutting down' });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        this.#json(response, 200, { status: 'ok' });
        return;
      }
      if (!this.#originAllowed(request)) {
        this.#json(response, 403, { error: 'Origin is not allowed' });
        return;
      }
      const upload = /^\/api\/workspaces\/([^/]+)\/artifacts$/.exec(url.pathname);
      const download = /^\/api\/artifacts\/([^/]+)$/.exec(url.pathname);
      const projectCreate = url.pathname === '/api/projects';
      const projectPick = url.pathname === '/api/projects/pick';
      const projectOpenFolder = /^\/api\/projects\/([^/]+)\/open-folder$/.exec(url.pathname);
      const projectFile = /^\/api\/projects\/([^/]+)\/files$/.exec(url.pathname);
      const projectComplete = /^\/api\/projects\/([^/]+)\/complete$/.exec(url.pathname);
      const projectDetail = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      const tree = /^\/api\/workspaces\/([^/]+)\/tree$/.exec(url.pathname);
      const search = /^\/api\/workspaces\/([^/]+)\/search$/.exec(url.pathname);
      const file = /^\/api\/workspaces\/([^/]+)\/file$/.exec(url.pathname);
      const gitStatus = /^\/api\/workspaces\/([^/]+)\/git\/status$/.exec(url.pathname);
      const gitDiff = /^\/api\/workspaces\/([^/]+)\/git\/diff$/.exec(url.pathname);
      const gitDetails = /^\/api\/workspaces\/([^/]+)\/git\/details$/.exec(url.pathname);
      const gitAction = /^\/api\/workspaces\/([^/]+)\/git\/action$/.exec(url.pathname);
      const computerPath = /^\/api\/computer-use(?:\/(enable|install|stop))?$/.exec(url.pathname);
      if (
        !upload &&
        !download &&
        !projectCreate &&
        !projectPick &&
        !projectOpenFolder &&
        !projectFile &&
        !projectComplete &&
        !projectDetail &&
        !tree &&
        !search &&
        !file &&
        !gitStatus &&
        !gitDetails &&
        !gitAction &&
        !gitDiff &&
        !computerPath
      ) {
        this.#json(response, 404, { error: 'Not found' });
        return;
      }
      const principal = await this.#authenticateHttp(request);
      if (!principal) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        this.#json(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (computerPath) {
        this.#requirePrincipalPermission(principal, 'admin');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
          throw Object.assign(new Error('Computer Use settings are local-only'), { httpStatus: 403 });
        const action = computerPath[1];
        if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) {
          this.#json(response, 405, { error: 'Method not allowed' });
          return;
        }
        const computer = this.#executionEnvironment.placement === 'local_device' ? this.#computer : undefined;
        if (!computer) {
          if (action) throw Object.assign(new Error('Computer Use requires a Windows local Pi runtime'), { httpStatus: 409 });
          this.#json(response, 200, { supported: false, enabled: false, ready: false, installing: false, platform: process.platform, python: '', error: '仅支持 Windows 本地设备的 Pi 运行时' });
          return;
        }
        if (action === 'enable') {
          let value: unknown;
          try { value = JSON.parse((await this.#readRequestBody(request)).toString('utf8')); }
          catch { throw Object.assign(new Error('Invalid JSON'), { httpStatus: 400 }); }
          if (!value || typeof value !== 'object' || Array.isArray(value) ||
              Object.keys(value).length !== 1 || typeof (value as { enabled?: unknown }).enabled !== 'boolean')
            throw Object.assign(new Error('Expected { enabled: boolean }'), { httpStatus: 400 });
          this.#json(response, 200, computer.setEnabled((value as { enabled: boolean }).enabled));
        } else if (action === 'stop') this.#json(response, 200, computer.stop());
        else if (action === 'install') this.#json(response, 202, computer.install());
        else this.#json(response, 200, url.searchParams.get('refresh') === '1' ? await computer.refresh() : computer.status());
        return;
      }
      if (projectOpenFolder && request.method === 'POST') {
        const projectId = this.#decodePathSegment(projectOpenFolder[1] ?? '');
        this.#requirePrincipalWorkspace(principal, projectId);
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (this.#executionEnvironment.placement !== 'local_device' || !this.#projects?.openFolder)
          throw Object.assign(new Error('仅支持在本地设备上打开项目目录。'), { httpStatus: 403 });
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
          throw Object.assign(new Error('请在项目所在的电脑上打开资源管理器。'), { httpStatus: 403 });
        await this.#projects.openFolder(principal.id, projectId);
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (projectPick && request.method === 'POST') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#projects)
          throw Object.assign(new Error('Project selection is unavailable'), { httpStatus: 501 });
        const remoteAddress = request.socket.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
          throw Object.assign(
            new Error('Local project selection is available only on the gateway computer'),
            { httpStatus: 403 }
          );
        }
        const content = await this.#readRequestBody(request);
        let value: unknown;
        try {
          value = JSON.parse(content.toString('utf8'));
        } catch {
          throw Object.assign(new Error('Project request must contain valid JSON'), {
            httpStatus: 400,
          });
        }
        const kind =
          value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
        if (kind !== undefined && kind !== 'file' && kind !== 'directory')
          throw Object.assign(new Error('Project kind must be file or directory'), {
            httpStatus: 400,
          });
        const project = await this.#projects.pick(principal.id, kind);
        if (!principal.workspaces.some((workspace) => workspace.id === project.id))
          principal.workspaces.push(project);
        this.#json(response, 200, { project });
        return;
      }
      if (projectCreate && request.method === 'POST') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#projects)
          throw Object.assign(new Error('Project import is unavailable'), { httpStatus: 501 });
        const content = await this.#readRequestBody(request);
        let value: unknown;
        try {
          value = JSON.parse(content.toString('utf8'));
        } catch {
          throw Object.assign(new Error('Project request must contain valid JSON'), {
            httpStatus: 400,
          });
        }
        const name =
          value && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
        if (typeof name !== 'string')
          throw Object.assign(new Error('Project name is required'), { httpStatus: 400 });
        this.#json(response, 201, { project: await this.#projects.create(principal.id, name) });
        return;
      }
      if (projectFile && request.method === 'PUT') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#projects)
          throw Object.assign(new Error('Project import is unavailable'), { httpStatus: 501 });
        const projectId = this.#decodePathSegment(projectFile[1] ?? '');
        const encodedPath = request.headers['x-wuming-project-path'];
        if (typeof encodedPath !== 'string')
          throw Object.assign(new Error('X-Wuming-Project-Path is required'), { httpStatus: 400 });
        let path: string;
        try {
          path = decodeURIComponent(encodedPath);
        } catch {
          throw Object.assign(new Error('X-Wuming-Project-Path is invalid'), { httpStatus: 400 });
        }
        await this.#projects.writeFile(
          principal.id,
          projectId,
          path,
          await this.#readRequestBody(request)
        );
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (projectComplete && request.method === 'POST') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#projects)
          throw Object.assign(new Error('Project import is unavailable'), { httpStatus: 501 });
        const projectId = this.#decodePathSegment(projectComplete[1] ?? '');
        const project = await this.#projects.complete(principal.id, projectId);
        if (!principal.workspaces.some((workspace) => workspace.id === project.id))
          principal.workspaces.push(project);
        this.#json(response, 200, { project });
        return;
      }
      if (projectDetail && request.method === 'PATCH') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#projects)
          throw Object.assign(new Error('Project management is unavailable'), { httpStatus: 501 });
        const projectId = this.#decodePathSegment(projectDetail[1] ?? '');
        this.#requirePrincipalWorkspace(principal, projectId);
        const content = await this.#readRequestBody(request);
        let value: unknown;
        try {
          value = JSON.parse(content.toString('utf8'));
        } catch {
          throw Object.assign(new Error('Project request must contain valid JSON'), {
            httpStatus: 400,
          });
        }
        const name =
          value && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
        if (typeof name !== 'string')
          throw Object.assign(new Error('Project name is required'), { httpStatus: 400 });
        const project = await this.#projects.rename(principal.id, projectId, name);
        const index = principal.workspaces.findIndex((workspace) => workspace.id === projectId);
        if (index >= 0) principal.workspaces[index] = project;
        this.#json(response, 200, { project });
        return;
      }
      if (projectDetail && request.method === 'DELETE') {
        this.#requirePrincipalPermission(principal, 'admin');
        if (!this.#projects)
          throw Object.assign(new Error('Project management is unavailable'), { httpStatus: 501 });
        const projectId = this.#decodePathSegment(projectDetail[1] ?? '');
        this.#requirePrincipalWorkspace(principal, projectId);
        await this.#projects.remove(principal.id, projectId);
        const index = principal.workspaces.findIndex((workspace) => workspace.id === projectId);
        if (index >= 0) principal.workspaces.splice(index, 1);
        for (const connection of this.#connections) {
          if (connection.principal.id !== principal.id) continue;
          for (const sessionId of connection.attachedSessions) {
            if (this.#store.loadSnapshot(sessionId)?.session.workspaceId === projectId)
              connection.attachedSessions.delete(sessionId);
          }
        }
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (upload && request.method === 'POST') {
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#artifacts)
          throw Object.assign(new Error('Artifact service is unavailable'), { httpStatus: 501 });
        const workspaceId = this.#decodePathSegment(upload[1] ?? '');
        this.#requirePrincipalWorkspace(principal, workspaceId);
        const encodedName = request.headers['x-wuming-file-name'];
        if (typeof encodedName !== 'string')
          throw Object.assign(new Error('X-Wuming-File-Name is required'), { httpStatus: 400 });
        let name: string;
        try {
          name = decodeURIComponent(encodedName);
        } catch {
          throw Object.assign(new Error('X-Wuming-File-Name is invalid'), { httpStatus: 400 });
        }
        const content = await this.#readRequestBody(request);
        const created = await this.#artifacts.create({
          workspaceId,
          ownerId: principal.id,
          name,
          ...(request.headers['content-type']
            ? { suppliedMimeType: request.headers['content-type'] }
            : {}),
          content,
        });
        this.#json(response, 201, { artifact: created.ref });
        return;
      }
      if (download && request.method === 'GET') {
        if (!this.#artifacts)
          throw Object.assign(new Error('Artifact service is unavailable'), { httpStatus: 501 });
        const artifactId = this.#decodePathSegment(download[1] ?? '');
        const metadata = this.#artifacts.get(artifactId);
        if (!metadata)
          throw Object.assign(new Error(`Artifact ${artifactId} does not exist`), {
            httpStatus: 404,
          });
        this.#requirePrincipalWorkspace(principal, metadata.workspaceId);
        const value = await this.#artifacts.read(artifactId);
        const encoded = encodeURIComponent(value.record.ref.name).replaceAll("'", '%27');
        response.writeHead(200, {
          'content-type': value.record.ref.mimeType,
          'content-length': String(value.content.length),
          'content-disposition': `attachment; filename="artifact"; filename*=UTF-8''${encoded}`,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        });
        response.end(value.content);
        return;
      }
      if (gitAction && request.method === 'POST') {
        const workspaceId = this.#decodePathSegment(gitAction[1] ?? '');
        this.#requirePrincipalWorkspace(principal, workspaceId);
        this.#requirePrincipalPermission(principal, 'workspace.write');
        if (!this.#workspace?.gitAction) throw Object.assign(new Error('Git 写操作仅在本地设备模式可用。'), { httpStatus: 403 });
        let value: unknown;
        try { value = JSON.parse((await this.#readRequestBody(request)).toString('utf8')); }
        catch { throw Object.assign(new Error('Git 请求必须是有效 JSON。'), { httpStatus: 400 }); }
        if (!checkGitAction.Check(value)) throw Object.assign(new Error('Git 操作参数无效。'), { httpStatus: 400 });
        this.#json(response, 200, await this.#workspace.gitAction(workspaceId, value));
        return;
      }
      if (gitDetails && request.method === 'GET') {
        const workspaceId = this.#decodePathSegment(gitDetails[1] ?? '');
        this.#requirePrincipalWorkspace(principal, workspaceId);
        if (!this.#workspace?.gitDetails) {
          this.#json(response, 200, { writable: false, isRepository: false, hasCommits: false, ahead: 0, behind: 0, conflicts: 0, remotes: [], blockedReason: 'Git 写操作仅在本地设备模式可用。' });
          return;
        }
        const details = await this.#workspace.gitDetails(workspaceId);
        if (!hasGatewayPermission(principal, 'workspace.write')) { details.writable = false; details.blockedReason = '当前账号没有工作区写入权限。'; }
        this.#json(response, 200, details);
        return;
      }
      const workspaceMatch = tree ?? search ?? file ?? gitStatus ?? gitDiff;
      if (workspaceMatch && request.method === 'GET') {
        if (!this.#workspace)
          throw Object.assign(new Error('Workspace service is unavailable'), { httpStatus: 501 });
        const workspaceId = this.#decodePathSegment(workspaceMatch[1] ?? '');
        this.#requirePrincipalWorkspace(principal, workspaceId);
        if (tree) {
          this.#json(
            response,
            200,
            await this.#workspace.listDirectory(workspaceId, this.#queryPath(url, '.'))
          );
          return;
        }
        if (search) {
          const query = url.searchParams.get('query') ?? '';
          if (query.length > 400)
            throw Object.assign(new Error('Search query is too long'), { httpStatus: 400 });
          const limit = Number(url.searchParams.get('limit') ?? 30);
          if (!Number.isFinite(limit) || limit < 1)
            throw Object.assign(new Error('Search limit is invalid'), { httpStatus: 400 });
          this.#json(
            response,
            200,
            await this.#workspace.searchFiles(workspaceId, query, Math.min(Math.trunc(limit), 200))
          );
          return;
        }
        if (file) {
          this.#json(
            response,
            200,
            await this.#workspace.readFile(workspaceId, this.#queryPath(url))
          );
          return;
        }
        if (gitStatus) {
          this.#json(response, 200, await this.#workspace.gitStatus(workspaceId));
          return;
        }
        const path = url.searchParams.get('path') ?? undefined;
        if (path && path.length > 4000)
          throw Object.assign(new Error('Workspace path is too long'), { httpStatus: 400 });
        this.#json(
          response,
          200,
          await this.#workspace.gitDiff(
            workspaceId,
            path,
            url.searchParams.get('staged') === 'true'
          )
        );
        return;
      }
      response.setHeader(
        'Allow',
        upload || projectCreate || projectPick || projectOpenFolder || projectComplete || gitAction
          ? 'POST'
          : projectFile
            ? 'PUT'
            : projectDetail
              ? 'PATCH, DELETE'
              : 'GET'
      );
      this.#json(response, 405, { error: 'Method not allowed' });
    } catch (error) {
      const status = this.#httpErrorStatus(error);
      if (status >= 500) this.#onError(error);
      if (!response.headersSent)
        this.#json(response, status, {
          error: error instanceof Error ? error.message : 'Request failed',
        });
      else response.destroy();
    }
  }

  #queryPath(url: URL, fallback?: string): string {
    const path = url.searchParams.get('path') ?? fallback;
    if (path === undefined || path.length === 0)
      throw Object.assign(new Error('Workspace path is required'), { httpStatus: 400 });
    if (path.length > 4000)
      throw Object.assign(new Error('Workspace path is too long'), { httpStatus: 400 });
    return path;
  }

  #decodePathSegment(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      throw Object.assign(new Error('URL path is invalid'), { httpStatus: 400 });
    }
  }

  async #authenticateHttp(request: IncomingMessage): Promise<GatewayPrincipal | undefined> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length).trim();
    return token ? await this.#auth.authenticate(token) : undefined;
  }

  #requirePrincipalWorkspace(principal: GatewayPrincipal, workspaceId: string): void {
    if (!principal.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw Object.assign(new Error('Workspace access denied'), { httpStatus: 403 });
    }
  }

  #requirePrincipalPermission(principal: GatewayPrincipal, permission: GatewayPermission): void {
    if (!hasGatewayPermission(principal, permission))
      throw Object.assign(new Error('Permission denied'), { httpStatus: 403 });
  }

  #isReadOnlyCommand(type: Command['type']): boolean {
    return [
      'workspace.list',
      'session.list',
      'session.search',
      'session.attach',
      'session.snapshot.get',
      'session.run.list',
      'session.run.trajectory.get',
      'evaluation.dataset.list',
      'session.run.evaluation.list',
      'session.memory.list',
      'session.memory.search',
      'goal.list',
      'team.get',
      'team.list',
      'agent.template.list',
      'automation.list',
      'automation.run.list',
      'skill.list',
      'skill.get',
      'skill.installed.list',
      'skill.preview',
      'mcp.list',
      'mcp.get',
      'tool.list',
      'model.list',
      'capability.list',
      'run.summary.get',
    ].includes(type);
  }

  async #readRequestBody(request: IncomingMessage): Promise<Buffer> {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > this.#maxArtifactBytes) {
      throw Object.assign(new Error('Artifact exceeds the upload limit'), { httpStatus: 413 });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > this.#maxArtifactBytes)
        throw Object.assign(new Error('Artifact exceeds the upload limit'), { httpStatus: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  #httpErrorStatus(error: unknown): number {
    if (error && typeof error === 'object' && 'httpStatus' in error)
      return Number((error as { httpStatus: number }).httpStatus);
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === 'not_found') return 404;
      if (code === 'forbidden') return 403;
      if (code === 'too_large') return 413;
      if (code === 'invalid') return 400;
      if (code === 'path_invalid' || code === 'path_escape') return 400;
      if (code === 'file_too_large') return 413;
      if (code === 'process_unavailable') return 503;
      if (code === 'process_failed' || code === 'process_timeout') return 500;
    }
    return 500;
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(value));
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (path !== '/api/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!this.#originAllowed(request)) return rejectUpgrade(socket, 403, 'Forbidden');
    const token = tokenFromProtocols(request.headers['sec-websocket-protocol']);
    if (!token) return rejectUpgrade(socket, 401, 'Unauthorized');
    let principal: GatewayPrincipal | undefined;
    try {
      principal = await this.#auth.authenticate(token);
    } catch (error) {
      this.#onError(error);
      return rejectUpgrade(socket, 500, 'Internal Server Error');
    }
    if (!principal) return rejectUpgrade(socket, 401, 'Unauthorized');
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws, principal, local));
  }

  #originAllowed(request: IncomingMessage): boolean {
    if (this.#strictLoopbackHost) {
      const address = this.#http.address();
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) return false;
    }
    const origin = request.headers.origin;
    if (!origin) return true;
    if (this.#allowedOrigins.has(origin)) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  #accept(ws: WebSocket, principal: GatewayPrincipal, local: boolean): void {
    const connection: ConnectionState = {
      ws,
      local,
      principal,
      connectionId: this.#idFactory(),
      hello: false,
      attachedSessions: new Set(),
      terminalUnsubscribers: new Set(),
    };
    this.#connections.add(connection);
    this.#logger.log('info', 'gateway.connection.opened', {
      connectionId: connection.connectionId,
      principalId: principal.id,
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'JSON text messages required');
      this.#activeRequests++;
      void this.#message(connection, data).finally(() => { this.#activeRequests--; });
    });
    ws.on('close', () => {
      this.#logger.log('info', 'gateway.connection.closed', {
        connectionId: connection.connectionId,
        principalId: connection.principal.id,
      });
      for (const unsubscribe of connection.terminalUnsubscribers) unsubscribe();
      connection.terminalUnsubscribers.clear();
      this.#terminal?.detachConnection(connection.connectionId);
      this.#connections.delete(connection);
    });
    ws.on('error', (error) => this.#onError(error));
  }

  async #message(connection: ConnectionState, raw: RawData): Promise<void> {
    if (this.#shuttingDown) return connection.ws.close(1001, 'Server shutting down');
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return connection.ws.close(1007, 'Invalid JSON');
    }
    if (!checkClientMessage.Check(value))
      return connection.ws.close(1002, 'Invalid protocol message');
    const message = value as import('@wuming/protocol').ClientMessage;
    if (!connection.hello) {
      if (message.type !== 'hello') return connection.ws.close(1002, 'Hello required');
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.#send(connection, {
          type: 'hello_error',
          error: {
            code: 'invalid_request',
            message: 'Unsupported protocol version',
            retryable: false,
          },
        });
        return connection.ws.close(1002, 'Unsupported protocol version');
      }
      connection.hello = true;
      connection.taskNotifications = message.capabilities.includes('task.notifications');
      this.#logger.log('debug', 'gateway.hello.accepted', {
        connectionId: connection.connectionId,
        clientId: message.clientId,
        resume: Boolean(message.resumeCursor),
      });
      this.#send(connection, {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        connectionId: connection.connectionId,
        capabilities: this.#capabilities,
        executionEnvironment: this.#executionEnvironment,
        serverTime: this.#clock(),
      });
      if (message.resumeCursor) this.#replay(connection, message.resumeCursor);
      return;
    }
    if (message.type === 'hello') return connection.ws.close(1002, 'Hello already completed');
    if (message.type !== 'request') {
      await this.#terminalMessage(connection, message as TerminalClientMessage);
      return;
    }
    await this.#request(connection, message.requestId, message.idempotencyKey, message.command);
  }

  async #terminalMessage(
    connection: ConnectionState,
    message: TerminalClientMessage
  ): Promise<void> {
    const terminal = this.#terminal;
    if (!terminal) {
      this.#send(connection, {
        type: 'terminal.error',
        ...('requestId' in message ? { requestId: message.requestId } : {}),
        code: 'not_implemented',
        message: 'Terminal service is disabled',
      });
      return;
    }
    try {
      if (message.type === 'terminal.shells') {
        this.#send(connection, terminal.shells(message.requestId));
        return;
      }
      if (message.type === 'terminal.create') {
        this.#requireWorkspace(connection, message.workspaceId);
        const ready = terminal.create({
          terminalId: message.terminalId,
          requestId: message.requestId,
          owner: { principalId: connection.principal.id, workspaceId: message.workspaceId },
          cols: message.cols,
          rows: message.rows,
          ...(message.shellId ? { shellId: message.shellId } : {}),
          connectionId: connection.connectionId,
          send: (value) => this.#send(connection, value),
        });
        connection.terminalUnsubscribers.add(
          terminal.listen(message.terminalId, connection.connectionId, (value) =>
            this.#send(connection, value)
          )
        );
        this.#send(connection, ready);
        return;
      }
      const owner = this.#terminalOwner(connection, message.terminalId);
      if (message.type === 'terminal.attach') {
        const ready = terminal.attach({
          ...message,
          owner,
          connectionId: connection.connectionId,
          send: (value) => this.#send(connection, value),
        });
        connection.terminalUnsubscribers.add(
          terminal.listen(message.terminalId, connection.connectionId, (value) =>
            this.#send(connection, value)
          )
        );
        this.#send(connection, ready);
        return;
      }
      if (message.type === 'terminal.input') terminal.input({ ...message, owner });
      else if (message.type === 'terminal.resize') terminal.resize({ ...message, owner });
      else this.#send(connection, terminal.close({ ...message, owner }));
    } catch (error) {
      const normalized = protocolError(error);
      this.#send(connection, {
        type: 'terminal.error',
        ...('requestId' in message ? { requestId: message.requestId } : {}),
        ...('terminalId' in message ? { terminalId: message.terminalId } : {}),
        code: error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code.slice(0, 100) : normalized.code,
        message: normalized.message,
      });
    }
  }

  #terminalOwner(
    connection: ConnectionState,
    terminalId: string
  ): { principalId: string; workspaceId: string } {
    const workspaceId = this.#terminal?.workspaceFor(terminalId, connection.principal.id);
    if (!workspaceId)
      throw Object.assign(new Error(`Terminal ${terminalId} is unavailable`), {
        protocolCode: 'forbidden',
      });
    this.#requireWorkspace(connection, workspaceId);
    return { principalId: connection.principal.id, workspaceId };
  }

  #replay(connection: ConnectionState, cursor: string): void {
    try {
      const feed = this.#store.loadEventFeed(cursor, 1001);
      if (feed.length > 1000) {
        this.#send(connection, {
          type: 'event',
          cursor: feed[999]?.cursor ?? cursor,
          event: { type: 'resync_required', reason: 'Replay window exceeded' },
        });
        return;
      }
      for (const stored of feed) this.#sendStoredEvent(connection, stored, false);
    } catch {
      this.#send(connection, {
        type: 'event',
        cursor,
        event: { type: 'resync_required', reason: 'Invalid or unavailable cursor' },
      });
    }
  }

  async #request(
    connection: ConnectionState,
    requestId: string,
    idempotencyKey: string,
    command: Command
  ): Promise<void> {
    const traceId = this.#idFactory();
    const startedAt = this.#clock();
    const sessionId =
      'sessionId' in command && typeof command.sessionId === 'string'
        ? command.sessionId
        : undefined;
    this.#logger.log('info', 'gateway.request.received', {
      traceId,
      requestId,
      idempotencyKey,
      connectionId: connection.connectionId,
      principalId: connection.principal.id,
      command: command.type,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    try {
      if (connection.principal.role === 'viewer' && !this.#isReadOnlyCommand(command.type))
        throw Object.assign(new Error('Permission denied'), { protocolCode: 'forbidden' });
      let result = await this.#dispatch(connection, idempotencyKey, command);
      const operationTracked =
        command.type === 'turn.prompt' ||
        command.type === 'turn.steer' ||
        command.type === 'turn.follow_up' ||
        command.type === 'subagent.create';
      const operationId =
        operationTracked && sessionId !== undefined
          ? this.#store.listOperations(sessionId, 1)[0]?.id
          : undefined;
      if (command.type === 'subagent.create' && result.type === 'subagent.created') {
        const subagent = result.subagent;
        const run = async () => {
          await this.#orchestrator.drainSession(subagent.sessionId, undefined, traceId);
          return this.#orchestrator.publishSubagentResult(command.sessionId, subagent.sessionId);
        };
        if (command.wait) result = { type: 'subagent.created', subagent: await run() };
        else
          void run().catch((error) => {
            if (!(error instanceof OrchestratorError && error.code === 'lease_conflict')) {
              this.#logger.log('error', 'gateway.subagent.run_failed', {
                sessionId: subagent.sessionId,
                parentSessionId: command.sessionId,
                error,
              });
              this.#onError(error);
            }
          });
      }
      if (command.type === 'goal.start' && result.type === 'goal.started') {
        void this.#orchestrator
          .driveGoal(command.sessionId, command.goalId, traceId)
          .catch((error) => {
            if (!(error instanceof OrchestratorError && error.code === 'lease_conflict')) {
              this.#logger.log('error', 'gateway.goal.run_failed', {
                goalId: command.goalId,
                parentSessionId: command.sessionId,
                error,
              });
              this.#onError(error);
            }
          });
      }
      if (command.type === 'goal.resume' && result.type === 'goal.resumed') {
        void (async () => {
          if (result.goal.plan === undefined && result.goal.runSessionId === undefined) {
            try {
              await this.#orchestrator.startGoal({
                principalId: 'system:goal',
                idempotencyKey: 'goal-resume-start:' + command.goalId + ':' + (traceId ?? 'resume'),
                sessionId: command.sessionId,
                goalId: command.goalId,
              });
            } catch (error) {
              if (!(error instanceof OrchestratorError && error.code === 'conflict')) throw error;
            }
          }
          await this.#orchestrator.driveGoal(command.sessionId, command.goalId, traceId);
        })()
          .catch((error) => {
            if (!(error instanceof OrchestratorError && error.code === 'lease_conflict'))
              this.#onError(error);
          });
      }
      if (command.type === 'automation.trigger' && result.type === 'automation.triggered') {
        void this.#orchestrator.dispatchAutomationRun(result.run.id, traceId).catch((error) => {
          if (!(error instanceof OrchestratorError && error.code === 'lease_conflict')) {
            this.#logger.log('error', 'gateway.automation.run_failed', {
              automationId: command.automationId,
              runId: result.run.id,
              parentSessionId: command.sessionId,
              error,
            });
            this.#onError(error);
          }
        });
      }
      if (command.type === 'approval.respond' && result.type === 'approval.accepted') {
        void this.#orchestrator.continueGoalForSession(command.sessionId).catch((error) => {
          if (!(error instanceof OrchestratorError && error.code === 'lease_conflict')) {
            this.#logger.log('error', 'gateway.goal.approval_continuation_failed', {
              sessionId: command.sessionId,
              error,
            });
            this.#onError(error);
          }
        });
      }
      this.#send(connection, { type: 'response', requestId, ok: true, result });
      this.#logger.log('info', 'gateway.request.completed', {
        traceId,
        requestId,
        command: command.type,
        durationMs: Math.max(0, this.#clock() - startedAt),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(operationId === undefined ? {} : { operationId }),
        resultType: result.type,
      });
      if (
        command.type === 'turn.prompt' ||
        command.type === 'turn.steer' ||
        command.type === 'turn.follow_up'
      ) {
        void this.#orchestrator
          .drainSession(command.sessionId, undefined, traceId)
          .catch((error) => {
            if (!(error instanceof OrchestratorError && error.code === 'lease_conflict')) {
              this.#logger.log('error', 'gateway.turn.drain_failed', {
                sessionId: command.sessionId,
                error,
              });
              this.#onError(error);
            }
          });
      }
    } catch (error) {
      this.#logger.log('error', 'gateway.request.failed', {
        traceId,
        requestId,
        command: command.type,
        durationMs: Math.max(0, this.#clock() - startedAt),
        ...(sessionId === undefined ? {} : { sessionId }),
        error,
      });
      this.#send(connection, {
        type: 'response',
        requestId,
        ok: false,
        error: protocolError(error),
      });
    }
  }

  async #dispatch(
    connection: ConnectionState,
    idempotencyKey: string,
    command: Command
  ): Promise<CommandResult> {
    if (command.type === 'model.official.list' || command.type === 'model.official.start' ||
        command.type === 'model.official.submit' || command.type === 'model.official.cancel' || command.type === 'model.official.logout') {
      if (!hasGatewayPermission(connection.principal, 'admin')) throw Object.assign(new Error('Permission denied'), { protocolCode: 'forbidden' });
      if (!connection.local) throw Object.assign(new Error('Official account management requires a local connection'), { protocolCode: 'forbidden' });
      if (!this.#officialAccounts) throw Object.assign(new Error('Official accounts are unavailable'), { protocolCode: 'not_implemented' });
      if (command.type === 'model.official.start') await this.#officialAccounts.start(command.provider, command.method);
      if (command.type === 'model.official.submit') this.#officialAccounts.submit(command.provider, command.loginId, command.code);
      if (command.type === 'model.official.cancel') await this.#officialAccounts.cancel(command.provider, command.loginId);
      if (command.type === 'model.official.logout') await this.#officialAccounts.logout(command.provider);
      return { type: 'model.official.accounts', accounts: this.#officialAccounts.accounts() };
    }
    if (command.type.startsWith('model.media.')) {
      this.#requirePrincipalPermission(connection.principal, 'admin');
      if (!this.#mediaModels) throw Object.assign(new Error('Media models are unavailable'), { protocolCode: 'not_implemented' });
      if (command.type === 'model.media.discover') return { type: 'model.media.discovered', kind: command.connection.kind, models: await this.#mediaModels.discover(command.connection) };
      if (command.type === 'model.media.image.default') await this.#mediaModels.setImageDefault(command.model);
      if (command.type === 'model.media.image.remove') await this.#mediaModels.removeImage(command.model);
      if (command.type === 'model.media.video.default') await this.#mediaModels.setVideoDefault(command.model);
      if (command.type === 'model.media.video.remove') await this.#mediaModels.removeVideo(command.model);
      if (command.type === 'model.media.set') {
        await this.#mediaModels.set(command.config);
      }
      if (command.type === 'model.media.remove') await this.#mediaModels.remove(command.kind);
      return { type: 'model.media.settings', settings: this.#mediaModels.list() };
    }
    switch (command.type) {
      case 'workspace.list':
        return { type: 'workspace.list', workspaces: connection.principal.workspaces };
      case 'usage.overview':
        this.#requireWorkspace(connection, command.workspaceId);
        return {
          type: 'usage.overview',
          overview: this.#store.usageOverview(command.workspaceId, this.#clock(), command.days),
        };
      case 'tool.list': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#tools)
          throw Object.assign(new Error('Tool catalog is unavailable'), {
            protocolCode: 'not_implemented',
          });
        const tools: ToolStatus[] = await this.#tools.list(command.workspaceId);
        return {
          type: 'tool.list',
          workspaceId: command.workspaceId,
          runtime: this.#tools.runtime,
          tools,
        };
      }
      case 'skill.list': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#skills || !this.#workspacePath)
          throw Object.assign(new Error('Skill catalog is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'skill.list',
          workspaceId: command.workspaceId,
          skills: await this.#skills.list(
            command.workspaceId,
            this.#workspacePath(command.workspaceId)
          ),
        };
      }
      case 'skill.get': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#skills || !this.#workspacePath)
          throw Object.assign(new Error('Skill catalog is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'skill.get',
          skill: await this.#skills.get(
            command.workspaceId,
            this.#workspacePath(command.workspaceId),
            command.skillId
          ),
        };
      }
      case 'skill.installed.list':
      case 'skill.install':
      case 'skill.preview':
      case 'skill.set_enabled':
      case 'skill.uninstall': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#skillManagement)
          throw Object.assign(new Error('Skill management is unavailable'), {
            protocolCode: 'not_implemented',
          });
        const manager = this.#skillManagement(command.workspaceId);
        if (command.type === 'skill.installed.list')
          return {
            type: 'skill.installed.list',
            workspaceId: command.workspaceId,
            skills: await manager.list(),
          };
        if (command.type === 'skill.preview')
          return {
            type: 'skill.preview',
            skill: await manager.get(command.workspaceId, command.skillId, true),
          };
        if (command.type === 'skill.install')
          return {
            type: 'skill.updated',
            workspaceId: command.workspaceId,
            skill: await manager.installFromWorkspace(command.sourcePath, {
              ...(command.skillId === undefined ? {} : { id: command.skillId }),
              ...(command.version === undefined ? {} : { version: command.version }),
            }),
          };
        if (command.type === 'skill.set_enabled')
          return {
            type: 'skill.updated',
            workspaceId: command.workspaceId,
            skill: await manager.setEnabled(command.skillId, command.enabled),
          };
        await manager.uninstall(command.skillId);
        return {
          type: 'skill.uninstalled',
          workspaceId: command.workspaceId,
          skillId: command.skillId,
        };
      }
      case 'mcp.list': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP catalog is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'mcp.list',
          workspaceId: command.workspaceId,
          servers: await this.#mcp.list(
            command.workspaceId,
            this.#workspacePath(command.workspaceId)
          ),
        };
      }
      case 'mcp.get': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP catalog is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'mcp.get',
          server: await this.#mcp.get(
            command.workspaceId,
            this.#workspacePath(command.workspaceId),
            command.serverId
          ),
        };
      }
      case 'mcp.configuration.get': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP management is unavailable'), { protocolCode: 'not_implemented' });
        const config = await this.#mcp.getConfiguration(this.#workspacePath(command.workspaceId), command.serverId);
        return { type: 'mcp.configuration', workspaceId: command.workspaceId, serverId: command.serverId, config };
      }
      case 'mcp.remove': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP management is unavailable'), { protocolCode: 'not_implemented' });
        await this.#mcp.removeServer(command.workspaceId, this.#workspacePath(command.workspaceId), command.serverId);
        return { type: 'mcp.removed', workspaceId: command.workspaceId, serverId: command.serverId };
      }
      case 'mcp.setEnabled': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP management is unavailable'), { protocolCode: 'not_implemented' });
        const server = await this.#mcp.setEnabled(command.workspaceId, this.#workspacePath(command.workspaceId), command.serverId, command.enabled);
        return { type: 'mcp.updated', workspaceId: command.workspaceId, server };
      }
      case 'mcp.configure':
      case 'mcp.trust':
      case 'mcp.untrust': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#mcp || !this.#workspacePath)
          throw Object.assign(new Error('MCP management is unavailable'), {
            protocolCode: 'not_implemented',
          });
        const workspaceRoot = this.#workspacePath(command.workspaceId);
        const server =
          command.type === 'mcp.configure'
            ? await this.#mcp.configureServer(command.workspaceId, workspaceRoot, command.config)
            : command.type === 'mcp.trust'
              ? await this.#mcp.trustServer(command.workspaceId, workspaceRoot, command.serverId)
              : await this.#mcp.untrustServer(command.workspaceId, workspaceRoot, command.serverId);
        return { type: 'mcp.updated', workspaceId: command.workspaceId, server };
      }
      case 'model.list':
        return {
          type: 'model.list',
          models: this.#availableModels(),
        };
      case 'model.custom.discover': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        const discovery = await this.#customModels.discover(command.connection);
        return { type: 'model.custom.discovered', ...discovery };
      }
      case 'model.custom.media.list':
        return { type: 'model.custom.media.list', models: this.#customModels?.listMedia?.() ?? [] };
      case 'model.custom.service.list': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return { type: 'model.custom.service.list', services: this.#customModels.services() };
      }
      case 'model.custom.service.refresh': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'model.custom.discovered',
          ...(await this.#customModels.refreshService(command.provider)),
        };
      }
      case 'model.custom.service.remove': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        await this.#customModels.removeService(command.provider);
        return { type: 'model.custom.service.removed', provider: command.provider };
      }
      case 'model.custom.get': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return { type: 'model.custom.settings', settings: this.#customModels.get(command.model) };
      }
      case 'model.custom.set': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        if (
          this.#models.some(
            (model) =>
              model.model.provider === command.config.provider &&
              model.model.id === command.config.id
          )
        ) {
          throw new OrchestratorError(
            'conflict',
            'A built-in model already uses that provider/model ID'
          );
        }
        const model = await this.#customModels.set(command.config);
        return { type: 'model.custom.configured', model };
      }
      case 'model.custom.remove': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        await this.#customModels.remove(command.model);
        return { type: 'model.custom.removed', model: command.model };
      }
      case 'model.custom.test': {
        if (!this.#customModels)
          throw Object.assign(new Error('Custom model configuration is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'model.custom.tested',
          model: command.model,
          latencyMs: await this.#customModels.test(command.model),
        };
      }
      case 'session.search': {
        this.#requireWorkspace(connection, command.workspaceId);
        return { type: 'session.search', ...this.#store.searchSessions(command.workspaceId, {
          ...command, excludeSessionIds: [...(this.#teams?.internalSessionIds() ?? [])],
        }) };
      }
      case 'session.list': {
        this.#requireWorkspace(connection, command.workspaceId);
        const internalSessions = this.#teams?.internalSessionIds() ?? new Set<string>();
        return {
          type: 'session.list',
          sessions: this.#store
            .listSnapshots(command.workspaceId, {
              ...(command.query === undefined ? {} : { query: command.query }),
              archived: command.archived ?? false,
              limit: command.limit ?? 100,
              excludeSessionIds: [...internalSessions],
            })
            .map((snapshot) => snapshot.session),
        };
      }
      case 'session.create': {
        this.#requireWorkspace(connection, command.workspaceId);
        const availableModels = this.#availableModels();
        const model = availableModels.find(
            (candidate) =>
              candidate.model.provider === command.model.provider &&
              candidate.model.id === command.model.id
          );
        if (availableModels.length > 0 || command.model.provider.startsWith('official-')) {
          if (!model?.authenticated)
            throw new OrchestratorError('conflict', 'Model is unavailable or not authenticated');
        }
        const result = await this.#orchestrator.createSession({
          principalId: connection.principal.id,
          idempotencyKey,
          workspaceId: command.workspaceId,
          ...(command.name === undefined ? {} : { name: command.name }),
          model: command.model,
          thinkingLevel: model ? clampModelThinkingLevel(model, command.thinkingLevel) : command.thinkingLevel,
          sandboxMode: command.sandboxMode,
          approvalPolicy: command.approvalPolicy,
          ...(command.costBudgetUsd === undefined ? {} : { costBudgetUsd: command.costBudgetUsd }),
          ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
          ...(command.budgetWarningThreshold === undefined
            ? {}
            : { budgetWarningThreshold: command.budgetWarningThreshold }),
        });
        connection.attachedSessions.add(result.snapshot.session.id);
        return result;
      }
      case 'session.attach': {
        const snapshot = this.#requireSession(connection, command.sessionId);
        connection.attachedSessions.add(command.sessionId);
        return { type: 'session.attached', snapshot };
      }
      case 'session.detach':
        this.#requireSession(connection, command.sessionId);
        connection.attachedSessions.delete(command.sessionId);
        return { type: 'session.detached', sessionId: command.sessionId };
      case 'session.snapshot.get':
        return {
          type: 'session.snapshot',
          snapshot: this.#requireSession(connection, command.sessionId),
        };
      case 'session.rename':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.renameSession({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          name: command.name,
        });
      case 'session.archive':
        this.#requireSession(connection, command.sessionId);
        if (this.#teams?.internalSessionIds().has(command.sessionId))
          throw new OrchestratorError('conflict', 'Team execution records cannot be archived as chats; manage the team from Agent Teams');
        return this.#orchestrator.archiveSession({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          archived: command.archived,
        });
      case 'session.fork': {
        this.#requireSession(connection, command.sessionId);
        const result = await this.#orchestrator.forkSession({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          ...(command.fromItemId === undefined ? {} : { fromItemId: command.fromItemId }),
        });
        // A fork is a creation, so it attaches like one: without this the
        // caller holds a snapshot of a session whose events it never
        // receives, and the next turn it starts there never renders.
        connection.attachedSessions.add(result.snapshot.session.id);
        return result;
      }
      case 'session.compact':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.compactSession({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
        });
      case 'session.model.set': {
        this.#requireSession(connection, command.sessionId);
        const model = this.#availableModels().find(
          (candidate) =>
            candidate.model.provider === command.model.provider &&
            candidate.model.id === command.model.id
        );
        if (
          (this.#availableModels().length > 0 || command.model.provider.startsWith('official-')) &&
          !model?.authenticated
        ) {
          throw new OrchestratorError('conflict', 'Model is unavailable or not authenticated');
        }
        return this.#orchestrator.setSessionModel({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          model: command.model,
          ...(model && (!model.reasoning || model.thinkingLevels)
            ? { thinkingLevels: model.reasoning ? model.thinkingLevels! : ['off'] as const } : {}),
        });
      }
      case 'session.thinking.set': {
        const snapshot = this.#requireSession(connection, command.sessionId);
        const model = this.#availableModels().find(
          (candidate) => candidate.model.provider === snapshot.model.provider && candidate.model.id === snapshot.model.id
        );
        return this.#orchestrator.setSessionThinking({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          thinkingLevel: model ? clampModelThinkingLevel(model, command.thinkingLevel) : command.thinkingLevel,
        });
      }
      case 'session.policy.set':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.setSessionPolicy({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          sandboxMode: command.sandboxMode,
          approvalPolicy: command.approvalPolicy,
        });
      case 'session.budget.set':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.setSessionBudget({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          ...(command.costBudgetUsd === undefined ? {} : { costBudgetUsd: command.costBudgetUsd }),
          ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
          ...(command.budgetWarningThreshold === undefined
            ? {}
            : { budgetWarningThreshold: command.budgetWarningThreshold }),
        });
      case 'session.run.list': {
        this.#requireSession(connection, command.sessionId);
        const sessionSnapshot = this.#store.loadSnapshot(command.sessionId);
        const operations = this.#store.listOperations(command.sessionId, command.limit ?? 20);
        return {
          type: 'session.run.list',
          sessionId: command.sessionId,
          runs: operations.map((operation: any) => ({
            id: operation.id,
            sessionId: operation.sessionId,
            mode: operation.payload.mode,
            status: operation.status,
            attempt: operation.attempt,
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
            ...(operation.startedAt === undefined ? {} : { startedAt: operation.startedAt }),
            ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
            abortRequested: operation.abortRequested,
            ...(operation.traceId === undefined ? {} : { traceId: operation.traceId }),
            ...(operation.error === undefined ? {} : { error: operation.error.slice(0, 4000) }),
            ...(operation.usage === undefined ? {} : { usage: operation.usage }),
            ...(operation.tools === undefined ? {} : { tools: operation.tools }),
            ...(sessionSnapshot === undefined
              ? {}
              : {
                  model:
                    sessionSnapshot.usageByTurn?.find((turn: any) => turn.turnId === operation.id)
                      ?.model ?? sessionSnapshot.model,
                }),
            ...(operation.failureKind === undefined ? {} : { failureKind: operation.failureKind }),
            ...(operation.retryHistory === undefined
              ? {}
              : {
                  retryHistory: operation.retryHistory.map((retry: any) => ({
                    attempt: retry.attempt,
                    maxAttempts: retry.maxAttempts,
                    delayMs: retry.delayMs,
                    error: retry.error,
                    timestamp: retry.timestamp ?? operation.updatedAt,
                  })),
                }),
            ...(operation.capabilityPlan === undefined
              ? {}
              : {
                  capabilityPlan: {
                    digest: operation.capabilityPlan.digest,
                    capabilityCount: operation.capabilityPlan.capabilities.length,
                    tools: operation.capabilityPlan.modelVisible.tools,
                    promptFragments: operation.capabilityPlan.modelVisible.promptFragments,
                  },
                }),
            ...(operation.contextPlan === undefined
              ? {}
              : {
                  contextPlan: {
                    digest: operation.contextPlan.digest,
                    cachePrefixDigest: operation.contextPlan.cachePrefixDigest,
                    estimatedSystemTokens: operation.contextPlan.estimatedSystemTokens,
                    availableSystemTokens: operation.contextPlan.budget.availableSystemTokens,
                    fragmentCount: operation.contextPlan.fragments.length,
                    omittedCount: operation.contextPlan.omitted.length,
                    fragments: operation.contextPlan.fragments.map(
                      ({ id, kind, source, renderedTokens, truncated, cacheScope }: any) => ({
                        id,
                        kind,
                        source,
                        renderedTokens,
                        truncated,
                        cacheScope,
                      })
                    ),
                  },
                }),
            ...(() => {
              const hookEvents = this.#store.listHookAuditRecords(operation.id, 100);
              return hookEvents.length === 0
                ? {}
                : {
                    hookEvents: hookEvents.map(
                      ({
                        hookId,
                        hookVersion,
                        point,
                        mode,
                        outcome,
                        startedAt,
                        finishedAt,
                        durationMs,
                        code,
                      }: any) => ({
                        hookId,
                        hookVersion,
                        point,
                        mode,
                        outcome,
                        startedAt,
                        finishedAt,
                        durationMs,
                        ...(code === undefined ? {} : { code }),
                      })
                    ),
                  };
            })(),
            ...(() => {
              const report = this.#store.trajectoryReport(operation.id);
              return report.replay.eventCount === 0 || report.replay.headDigest === null
                ? {}
                : {
                    trajectory: {
                      eventCount: report.replay.eventCount,
                      headDigest: report.replay.headDigest,
                      integrity: report.replay.integrity,
                      evaluation: report.evaluation,
                    },
                  };
            })(),
            ...(() => {
              const memoryCount = this.#store.countOperationMemories(operation.id);
              return memoryCount === 0 ? {} : { memoryCount };
            })(),
          })),
        };
      }
      case 'session.run.trajectory.get': {
        this.#requireSession(connection, command.sessionId);
        const operation = this.#store.getOperation(command.runId);
        if (!operation || operation.sessionId !== command.sessionId)
          throw new OrchestratorError('not_found', `Run ${command.runId} does not exist`);
        return {
          type: 'session.run.trajectory',
          sessionId: command.sessionId,
          runId: command.runId,
          report: this.#store.trajectoryReport(command.runId),
        };
      }
      case 'evaluation.dataset.list':
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return {
          type: 'evaluation.dataset.list',
          workspaceId: command.workspaceId,
          datasets: this.#evaluation.listDatasets(command.workspaceId),
        };
      case 'evaluation.dataset.create':
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return this.#evaluation.createDataset({
          principalId: connection.principal.id,
          idempotencyKey,
          workspaceId: command.workspaceId,
          name: command.name,
          graders: command.graders,
        });
      case 'evaluation.dataset.delete':
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        return this.#evaluation.deleteDataset({
          principalId: connection.principal.id,
          idempotencyKey,
          workspaceId: command.workspaceId,
          datasetId: command.datasetId,
        });
      case 'session.run.evaluate': {
        const snapshot = this.#requireSession(connection, command.sessionId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        const operation = this.#requireTerminalRun(command.sessionId, command.runId);
        return this.#evaluation.evaluate({
          principalId: connection.principal.id,
          idempotencyKey,
          snapshot,
          runId: operation.id,
          trajectory: this.#store.trajectoryReport(operation.id),
          ...(command.datasetId === undefined ? {} : { datasetId: command.datasetId }),
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.graders === undefined ? {} : { graders: command.graders }),
        });
      }
      case 'session.run.evaluation.list':
        this.#requireSession(connection, command.sessionId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        this.#requireRun(command.sessionId, command.runId);
        return {
          type: 'session.run.evaluation.list',
          sessionId: command.sessionId,
          runId: command.runId,
          evaluations: this.#evaluation.listEvaluations(
            command.sessionId,
            command.runId,
            command.limit ?? 20
          ),
        };
      case 'session.run.attestation.create':
        this.#requireSession(connection, command.sessionId);
        if (!this.#evaluation)
          throw Object.assign(new Error('Evaluation service is unavailable'), {
            protocolCode: 'not_implemented',
          });
        this.#requireTerminalRun(command.sessionId, command.runId);
        return this.#evaluation.attest({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          runId: command.runId,
          evaluationId: command.evaluationId,
        });
      case 'session.memory.list':
        this.#requireSession(connection, command.sessionId);
        return {
          type: 'session.memory.list',
          sessionId: command.sessionId,
          memories: this.#store.listMemoryRecords(command.sessionId, {
            limit: command.limit ?? 20,
          }),
        };
      case 'session.memory.search': {
        this.#requireSession(connection, command.sessionId);
        const query = command.query.trim();
        if (!query) throw new OrchestratorError('conflict', 'Memory search query cannot be empty');
        return {
          type: 'session.memory.search',
          sessionId: command.sessionId,
          query,
          matches: this.#store.searchMemories(command.sessionId, query, command.limit ?? 5),
        };
      }
      case 'session.memory.manage':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.manageMemory({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          memoryId: command.memoryId,
          action: command.action,
        });
      case 'agent.template.list':
      case 'agent.template.save':
      case 'agent.template.delete': {
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#teams) throw new OrchestratorError('conflict', 'Agent templates are unavailable');
        const canEditUser = hasGatewayPermission(connection.principal, 'admin');
        const canEditProject = hasGatewayPermission(connection.principal, 'workspace.write');
        if (command.type !== 'agent.template.list' && command.scope === 'user' && !canEditUser)
          throw Object.assign(new Error('User-wide Agent templates require owner permission'), { protocolCode: 'forbidden' });
        if (command.type === 'agent.template.save')
          this.#teams.templates.save(command.workspaceId, command.scope, command.template, command.expectedRevision);
        if (command.type === 'agent.template.delete')
          this.#teams.templates.delete(command.workspaceId, command.scope, command.name, command.expectedRevision);
        return { type: 'agent.templates', templates: this.#teams.templates.list(command.workspaceId), canEditUser, canEditProject };
      }
      case 'team.list':
        this.#requireWorkspace(connection, command.workspaceId);
        if (!this.#teams) throw new OrchestratorError('conflict', 'Agent Teams are unavailable');
        return { type: 'team.list', teams: this.#teams.list(command.workspaceId) };
      case 'team.start': {
        this.#requireSession(connection, command.sessionId);
        if (!this.#teams) throw new OrchestratorError('conflict', 'Agent Teams are unavailable');
        const team = await this.#teams.start(command.sessionId, command.objective, command.name, true, `rpc:${connection.principal.id}:${idempotencyKey}`);
        return { type: 'team.snapshot', team };
      }
      case 'team.get':
      case 'team.message':
      case 'team.stop':
      case 'team.retry': {
        if (!this.#teams) throw new OrchestratorError('conflict', 'Agent Teams are unavailable');
        if (Boolean(command.teamId) === Boolean(command.sessionId))
          throw new OrchestratorError('conflict', 'Provide exactly one teamId or legacy sessionId');
        if (command.sessionId) this.#requireSession(connection, command.sessionId);
        const team = command.teamId ? this.#teams.store.get(command.teamId) : this.#teams.get(command.sessionId!);
        if (!team || (command.teamId && team.id !== command.teamId)) {
          if (command.type === 'team.get' && command.sessionId) return { type: 'team.snapshot', team: null };
          throw new OrchestratorError('not_found', 'Team not found');
        }
        const workspaceId = team.workspaceId ?? this.#store.loadSnapshot(team.sessionId)?.session.workspaceId;
        if (!workspaceId) throw new OrchestratorError('not_found', 'Team workspace not found');
        this.#requireWorkspace(connection, workspaceId);
        if (command.sessionId && command.type !== 'team.get' && command.sessionId !== team.sessionId)
          throw new OrchestratorError('conflict', 'Use teamId to control the team');
        if (command.type === 'team.message') this.#teams.send(team.sessionId, command.recipient, command.text, `rpc:${connection.principal.id}:${idempotencyKey}`, true);
        if (command.type === 'team.stop') await this.#teams.stop(team.id);
        if (command.type === 'team.retry') this.#teams.retry(team.sessionId, command.memberId, `rpc:${connection.principal.id}:${idempotencyKey}`);
        return { type: 'team.snapshot', team: this.#teams.get(team.id, command.type === 'team.get' ? command.revision : undefined) ?? null };
      }
      case 'subagent.create':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.createSubagent({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          task: command.task,
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.costBudgetUsd === undefined ? {} : { costBudgetUsd: command.costBudgetUsd }),
          ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
        });
      case 'subagent.list': {
        this.#requireSession(connection, command.sessionId);
        const depth = this.#orchestrator.subagentDepth(command.sessionId);
        return {
          type: 'subagent.list',
          sessionId: command.sessionId,
          depth,
          canCreate: depth < MAX_SUBAGENT_DEPTH,
          subagents: this.#orchestrator.listSubagents(command.sessionId, command.limit ?? 100),
        };
      }
      case 'subagent.cancel':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.cancelSubagent({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          subagentId: command.subagentId,
        });
      case 'goal.create':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.createGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          objective: command.objective,
          ...(command.skillId === undefined ? {} : { skillId: command.skillId }),
          ...(command.executionMode === undefined ? {} : { executionMode: command.executionMode }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.successCriteria === undefined
            ? {}
            : { successCriteria: command.successCriteria }),
          ...(command.maxRounds === undefined ? {} : { maxRounds: command.maxRounds }),
          ...(command.plan === undefined ? {} : { plan: command.plan }),
        });
      case 'goal.list':
        this.#requireSession(connection, command.sessionId);
        return {
          type: 'goal.list',
          sessionId: command.sessionId,
          goals: this.#orchestrator.listGoals(command.sessionId, command.limit ?? 100),
        };
      case 'goal.start':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.startGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          goalId: command.goalId,
        });
      case 'goal.pause':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.pauseGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          goalId: command.goalId,
        });
      case 'goal.resume':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.resumeGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          goalId: command.goalId,
        });
      case 'goal.delete':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.deleteGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          goalId: command.goalId,
        });
      case 'goal.cancel':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.cancelGoal({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          goalId: command.goalId,
        });
      case 'automation.create':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.createAutomation({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          objective: command.objective,
          schedule: command.schedule,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.successCriteria === undefined
            ? {}
            : { successCriteria: command.successCriteria }),
          ...(command.maxRounds === undefined ? {} : { maxRounds: command.maxRounds }),
          ...(command.plan === undefined ? {} : { plan: command.plan }),
        });
      case 'automation.list':
        this.#requireSession(connection, command.sessionId);
        return {
          type: 'automation.list',
          sessionId: command.sessionId,
          automations: this.#orchestrator.listAutomations(command.sessionId, command.limit ?? 100),
        };
      case 'automation.set_enabled':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.setAutomationEnabled({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          automationId: command.automationId,
          enabled: command.enabled,
        });
      case 'automation.trigger':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.triggerAutomation({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          automationId: command.automationId,
        });
      case 'automation.run.list':
        this.#requireSession(connection, command.sessionId);
        return {
          type: 'automation.run.list',
          sessionId: command.sessionId,
          automationId: command.automationId,
          runs: this.#orchestrator.listAutomationRuns(
            command.sessionId,
            command.automationId,
            command.limit ?? 50
          ),
        };
      case 'turn.prompt':
      case 'turn.steer':
      case 'turn.follow_up':
        const session = this.#requireSession(connection, command.sessionId);
        let selectedSkillIds = command.skills;
		const teamGoal = teamCommandGoal(command.content);
		const explicitTeam = command.skills?.includes('team') || teamGoal !== undefined;
		if (explicitTeam) {
			if (!this.#teams) throw new OrchestratorError('conflict', 'Agent Teams 当前不可用，未启动团队');
			if (command.type !== 'turn.prompt' || session.session.phase !== 'idle')
				throw new OrchestratorError('conflict', '请先停止当前任务，或在新对话中启动团队');
			if (this.#teams.get(command.sessionId)) throw new OrchestratorError('conflict', '团队成员不能启动嵌套团队');
			const objective = teamGoal ?? command.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim();
			if (!objective) throw new OrchestratorError('conflict', '请提供团队任务目标，例如 /team 帮我做一个图书管理系统');
			selectedSkillIds = [...new Set([...(selectedSkillIds ?? []), 'team'])];
		}
		const running = this.#store.getRunningOperation(command.sessionId);
		if (running && isTeamLaunch(running.payload))
			throw new OrchestratorError('conflict', '团队正在创建，请等待创建结果');
        if (
          this.#autoRouteSkills &&
          !selectedSkillIds?.length &&
          this.#skills &&
          this.#workspacePath
        ) {
          const text = command.content
            .filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('`n');
          const routed = routeSkills(
            text,
            await this.#skills.list(
              session.session.workspaceId,
              this.#workspacePath(session.session.workspaceId)
            )
          );
          if (routed.length > 0) selectedSkillIds = routed.filter((route) => route.skill.id !== 'team').map((route) => route.skill.id);
        }
        if (command.content.some((part: any) => part.type === 'artifact')) {
          if (!this.#artifacts)
            throw Object.assign(new Error('Artifact service is unavailable'), {
              protocolCode: 'not_implemented',
            });
          for (const part of command.content) {
            if (part.type === 'artifact')
              this.#artifacts.assertReference(part.artifact, session.session.workspaceId);
          }
        }
        if (selectedSkillIds && selectedSkillIds.length > 0) {
          if (!this.#skills || !this.#workspacePath)
            throw Object.assign(new Error('Skill catalog is unavailable'), {
              protocolCode: 'not_implemented',
            });
          const available = new Set(
            (
              await this.#skills.list(
                session.session.workspaceId,
                this.#workspacePath(session.session.workspaceId)
              )
            ).map((skill) => skill.id)
          );
          const missing = selectedSkillIds.find((skillId: any) => !available.has(skillId));
          if (missing)
            throw Object.assign(new Error(`Skill ${missing} does not exist`), {
              protocolCode: 'not_found',
            });
        }
        return this.#orchestrator.acceptTurn({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          mode:
            command.type === 'turn.prompt'
              ? 'prompt'
              : command.type === 'turn.steer'
                ? 'steer'
                : 'follow_up',
          content: command.content,
          ...(selectedSkillIds === undefined ? {} : { skills: selectedSkillIds }),
        });
      case 'turn.abort':
        this.#requireSession(connection, command.sessionId);
        return this.#orchestrator.abortTurn({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
        });
      case 'approval.respond':
        this.#requireSession(connection, command.sessionId);
        if (this.#store.loadSnapshot(command.sessionId)?.pendingApprovals
          .find((approval) => approval.id === command.approvalId)?.capabilities
          .some((capability) => capability.type === 'computer.use')) {
          if (!hasGatewayPermission(connection.principal, 'admin'))
            throw Object.assign(new Error('Desktop approval requires the device owner'), { protocolCode: 'forbidden' });
          if (!connection.local)
            throw Object.assign(new Error('Desktop approval requires the local device owner'), { protocolCode: 'forbidden' });
        }
        if (!this.#approvals) {
          throw Object.assign(new Error('Approval handling is unavailable'), {
            protocolCode: 'not_implemented',
          });
        }
        return this.#approvals.respond({
          principalId: connection.principal.id,
          idempotencyKey,
          sessionId: command.sessionId,
          approvalId: command.approvalId,
          decision: command.decision,
        });
      default:
        throw Object.assign(
          new Error(`Command ${(command as { type: string }).type} is not implemented`),
          {
            protocolCode: 'not_implemented',
          }
        );
    }
  }

  #requireWorkspace(connection: ConnectionState, workspaceId: string): void {
    if (!connection.principal.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw Object.assign(new Error('Workspace access denied'), { protocolCode: 'forbidden' });
    }
  }

  #requireSession(connection: ConnectionState, sessionId: string) {
    const snapshot = this.#store.loadSnapshot(sessionId);
    if (!snapshot) throw new OrchestratorError('not_found', `Session ${sessionId} does not exist`);
    this.#requireWorkspace(connection, snapshot.session.workspaceId);
    return snapshot;
  }

  #requireRun(sessionId: string, runId: string) {
    const operation = this.#store.getOperation(runId);
    if (!operation || operation.sessionId !== sessionId)
      throw new OrchestratorError('not_found', `Run ${runId} does not exist`);
    return operation;
  }

  #requireTerminalRun(sessionId: string, runId: string) {
    const operation = this.#requireRun(sessionId, runId);
    if (operation.status === 'queued' || operation.status === 'running') {
      throw new OrchestratorError('conflict', `Run ${runId} has not reached a terminal state`);
    }
    return operation;
  }

  #goalProgressEvent(event: ProgressEvent): ProgressEvent | undefined {
    const goal = this.#store.findGoalByRunSessionId(event.sessionId);
    if (!goal || goal.parentSessionId === event.sessionId) return undefined;
    return {
      ...event,
      sessionId: goal.parentSessionId,
      goalId: goal.id,
      runSessionId: event.sessionId,
    } as ProgressEvent;
  }

  #publicEvent(stored: StoredSessionEvent): DurableEvent | undefined {
    const event = stored.event;
    switch (event.type) {
      case 'session.request.usage.updated':
        return {
          type: 'session.request.usage.updated',
          sessionId: event.sessionId,
          revision: event.revision,
          request: event.request,
        };
      case 'session.context.updated':
        return {
          type: 'session.context.updated',
          sessionId: event.sessionId,
          revision: event.revision,
          contextUsage: event.contextUsage,
        };
      case 'session.item.upserted':
        return {
          type: 'session.item.upserted',
          sessionId: event.sessionId,
          revision: event.revision,
          item: event.item,
        };
      case 'session.phase.changed':
        return {
          type: 'session.phase.changed',
          sessionId: event.sessionId,
          revision: event.revision,
          phase: event.phase,
        };
      case 'approval.requested':
        return {
          type: 'approval.requested',
          sessionId: event.sessionId,
          revision: event.revision,
          approval: event.approval,
        };
      case 'approval.settled':
        return {
          type: 'approval.settled',
          sessionId: event.sessionId,
          revision: event.revision,
          approval: event.approval,
        };
      default: {
        const snapshot = this.#store.loadSnapshot(event.sessionId);
        return snapshot ? { type: 'session.snapshot', snapshot } : undefined;
      }
    }
  }

  #broadcastStoredEvent(stored: StoredSessionEvent): void {
    for (const connection of this.#connections) this.#sendStoredEvent(connection, stored, true);
    const event = stored.event;
    if (event.type !== 'approval.requested' && !(event.type === 'session.phase.changed' && event.phase === 'idle')) return;
    const snapshot = this.#store.loadSnapshot(event.sessionId);
    if (!snapshot || snapshot.session.parentSessionId || snapshot.session.archivedAt !== undefined) return;
    const operation = event.type === 'approval.requested' ? undefined : this.#store.listOperations(event.sessionId, 1)[0];
    const kind = event.type === 'approval.requested' ? 'approval'
      : operation?.finishedAt === event.timestamp && operation.status === 'completed' ? 'completed'
      : operation?.finishedAt === event.timestamp && operation.status === 'failed' ? 'failed' : undefined;
    if (!kind) return;
    for (const connection of this.#connections) {
      if (!connection.hello || !connection.taskNotifications ||
        !connection.principal.workspaces.some((workspace) => workspace.id === snapshot.session.workspaceId)) continue;
      this.#send(connection, { type: 'task.notification', id: event.eventId,
        sessionId: event.sessionId, workspaceId: snapshot.session.workspaceId, kind });
    }
  }

  #sendStoredEvent(
    connection: ConnectionState,
    stored: StoredSessionEvent,
    requireAttachment: boolean
  ): void {
    if (!connection.hello) return;
    const snapshot = this.#store.loadSnapshot(stored.event.sessionId);
    if (!snapshot) return;
    if (
      !connection.principal.workspaces.some(
        (workspace) => workspace.id === snapshot.session.workspaceId
      )
    )
      return;
    if (requireAttachment && !connection.attachedSessions.has(stored.event.sessionId)) return;
    const event = this.#publicEvent(stored);
    if (event) this.#send(connection, { type: 'event', cursor: stored.cursor, event });
  }

  #send(connection: ConnectionState, message: any): void {
    if (!checkServerMessage.Check(message)) {
      this.#onError(new Error('Gateway attempted to send an invalid protocol message'));
      return connection.ws.close(1011, 'Invalid server message');
    }
    if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify(message));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#http.once('error', onError);
      this.#http.listen(port, host, () => {
        this.#http.off('error', onError);
        resolve();
      });
    });
    return this.#http.address() as AddressInfo;
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    for (const connection of this.#connections) connection.ws.close(1001, 'Server shutting down');
  }

  #availableModels(): ModelMetadata[] {
    return [...this.#models, ...(this.#customModels?.list() ?? []), ...(this.#officialAccounts?.list() ?? [])];
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.#officialAccounts?.dispose();
    this.#unsubscribeStore();
    this.#unsubscribeProgress();
    for (const connection of this.#connections) connection.ws.close(1001, 'Server shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    if (this.#http.listening)
      await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
