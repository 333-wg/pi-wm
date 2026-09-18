import Type, { type Static } from "typebox";

export const ArtifactRefSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 200 }),
		name: Type.String({ minLength: 1, maxLength: 500 }),
		mimeType: Type.String({ minLength: 1, maxLength: 200 }),
		size: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false }
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;
