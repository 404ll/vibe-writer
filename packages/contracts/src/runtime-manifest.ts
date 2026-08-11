import { z } from 'zod'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const RuntimeArtifactSchema = z.object({
  path: z.string().min(1),
  role: z.enum(['prompts', 'model-runtime', 'tool-loop', 'graph']),
  sha256: Sha256Schema,
})

export const RuntimeManifestSchema = z.object({
  schema_version: z.literal(1),
  baseline_id: z.string().min(1),
  implementation: z.enum(['python', 'typescript']),
  captured_at: z.string(),
  code_revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  contracts_version: z.string().min(1),
  graph: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    nodes: z.array(z.string()).min(1),
    conditional_edges: z.array(z.string()),
  }),
  model_profile: z.object({
    id: z.string().min(1),
    protocol: z.string().min(1),
    model_env: z.string().min(1),
    default_model: z.string().min(1),
    required_env: z.array(z.string()),
    optional_env: z.array(z.string()),
  }),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      owner: z.string().min(1),
    }),
  ),
  artifacts: z.array(RuntimeArtifactSchema).min(1),
})

export type RuntimeArtifact = z.infer<typeof RuntimeArtifactSchema>
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>
