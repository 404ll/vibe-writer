import { readFileSync } from 'node:fs'
import {
  preflightMemoryCalibrationExecution,
  quoteTrackedMemoryCalibrationCost,
} from './memory-calibration-execution.ts'

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

try {
  const [mode, path, ...rest] = process.argv.slice(2)
  if (rest.length > 0 || (mode !== undefined && path === undefined)) {
    throw new Error('Usage: memory-calibration:preflight [--quote path | --manifest path]')
  }
  if (mode === undefined) {
    process.stdout.write(`${JSON.stringify({
      status: 'configuration_required',
      executable: false,
      requiredInput: ['model', 'modelProfile', 'codeRevision', 'maxOutputTokens', 'pricingSnapshot'],
      nextCommands: {
        quote: 'pnpm eval:memory-calibration:preflight -- --quote /absolute/path/to/quote-input.json',
        preflight: 'pnpm eval:memory-calibration:preflight -- --manifest /absolute/path/to/execution.json',
      },
    }, null, 2)}\n`)
  } else if (mode === '--quote') {
    const input = readJson(path!) as { maxOutputTokens?: unknown; pricing?: unknown }
    process.stdout.write(`${JSON.stringify(quoteTrackedMemoryCalibrationCost({
      maxOutputTokens: input.maxOutputTokens as number,
      pricing: input.pricing,
    }), null, 2)}\n`)
  } else if (mode === '--manifest') {
    process.stdout.write(`${JSON.stringify(preflightMemoryCalibrationExecution(readJson(path!)), null, 2)}\n`)
  } else {
    throw new Error('Usage: memory-calibration:preflight [--quote path | --manifest path]')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown calibration preflight error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
}
