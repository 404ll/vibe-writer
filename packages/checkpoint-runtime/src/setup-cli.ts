import { createPostgresSaver } from './runtime'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const saver = createPostgresSaver(requiredEnvironment('DATABASE_CHECKPOINT_ADMIN_URL'))
try {
  await saver.setup()
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    command: 'checkpoint-schema-setup',
    schema: 'langgraph_checkpoint',
    status: 'ready',
  })}\n`)
} finally {
  await saver.end()
}
