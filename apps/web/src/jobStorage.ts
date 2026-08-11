'use client'

import { useSyncExternalStore } from 'react'

export const ACTIVE_JOB_STORAGE_KEY = 'vibe-writer:active-job:v1'
const LEGACY_ACTIVE_JOB_STORAGE_KEY = 'vibe_active_job_id'
const ACTIVE_JOB_CHANGED_EVENT = 'vibe-writer:active-job-changed'

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export function readActiveJobId(): string | null {
  const storage = browserStorage()
  return storage?.getItem(ACTIVE_JOB_STORAGE_KEY)
    ?? storage?.getItem(LEGACY_ACTIVE_JOB_STORAGE_KEY)
    ?? null
}

function notifyActiveJobChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ACTIVE_JOB_CHANGED_EVENT))
  }
}

export function writeActiveJobId(jobId: string) {
  const storage = browserStorage()
  if (!storage) return
  storage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId)
  storage.removeItem(LEGACY_ACTIVE_JOB_STORAGE_KEY)
  notifyActiveJobChanged()
}

export function clearActiveJobId() {
  const storage = browserStorage()
  if (!storage) return
  storage.removeItem(ACTIVE_JOB_STORAGE_KEY)
  storage.removeItem(LEGACY_ACTIVE_JOB_STORAGE_KEY)
  notifyActiveJobChanged()
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(ACTIVE_JOB_CHANGED_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(ACTIVE_JOB_CHANGED_EVENT, onStoreChange)
  }
}

export function useActiveJobId() {
  return useSyncExternalStore(subscribe, readActiveJobId, () => null)
}
