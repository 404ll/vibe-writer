import { readTrackedMemoryCalibrationReadiness } from './memory-calibration-readiness.ts'

try {
  const result = readTrackedMemoryCalibrationReadiness()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown calibration readiness error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
}
