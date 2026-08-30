import 'server-only'

import {
  MemoryConsentPolicyDocumentSchema,
  type MemoryConsentPolicyDocument,
} from '@vibe-writer/contracts/memory-policy'

const POLICY_DEFINITIONS: Readonly<Record<string, unknown>> = {
  'memory-consent-v1': {
    schema_version: 1,
    version: 'memory-consent-v1',
    title: '长期记忆使用说明',
    summary: '只在你明确提交后保存稳定偏好、约束或纠正，并允许你随时查看和删除。',
    statements: [
      {
        key: 'explicit-consent',
        title: '明确提交才保存',
        description: '普通对话不会自动成为长期记忆；只有你在此处确认提交的内容才会进入候选提取流程。',
      },
      {
        key: 'human-review',
        title: '模型提案需要治理',
        description: '模型提取结果先成为候选项；具备审核权限的成员确认后，才会成为当前工作区可读取的长期记忆。',
      },
      {
        key: 'scope-and-erasure',
        title: '限定范围并支持删除',
        description: '记忆受当前工作区和目标主体约束；你可以撤回自己的来源内容，工作区所有者可以删除已生效记忆。',
      },
      {
        key: 'retention',
        title: '保留期明确',
        description: '每次提交都带有保留天数；到期数据由独立维护进程主动清理，不会无限期保留。',
      },
    ],
    retention: {
      minimum_days: 1,
      default_days: 30,
      maximum_days: 365,
    },
    allowed_signal_kinds: [
      'explicit_remember',
      'preference_setting',
      'correction',
    ],
  },
}

export function getRegisteredMemoryConsentPolicy(
  version: string | undefined,
): MemoryConsentPolicyDocument | null {
  if (!version) return null
  const definition = POLICY_DEFINITIONS[version]
  if (!definition) return null
  const parsed = MemoryConsentPolicyDocumentSchema.safeParse(definition)
  return parsed.success ? parsed.data : null
}
