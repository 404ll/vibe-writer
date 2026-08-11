import { WritingWorkspace } from '../src/components/WritingWorkspace'
import {
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
} from '../src/server/durableDatabase'

export const dynamic = 'force-dynamic'

export default function HomePage() {
  return (
    <WritingWorkspace
      memoryManagementEnabled={durableApiEnabled() && durableMemoryManagementApiEnabled()}
    />
  )
}
