import { WritingWorkspace } from '@/components/writing/WritingWorkspace'
import {
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
} from '@/server/database/durableDatabase'

export const dynamic = 'force-dynamic'

export default function HomePage() {
  return (
    <WritingWorkspace
      memoryManagementEnabled={durableApiEnabled() && durableMemoryManagementApiEnabled()}
    />
  )
}
