import type { SettlementSnapshot } from './types'

// 归因结算快照独立持久化：与业务记录分键存放，结算写入失败时可以整体回滚，
// 模型下线后快照保留在本地，历史渠道归因明细不丢。
const STORAGE_KEY = 'data-product-ops:attribution-settlements'

// 非浏览器环境（如脚本自测）下的内存兜底
let memoryFallback: Record<string, SettlementSnapshot> = {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readAll(): Record<string, SettlementSnapshot> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(memoryFallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, SettlementSnapshot>
  } catch {
    return {}
  }
}

export function getSettlement(modelId: number): SettlementSnapshot | null {
  const hit = readAll()[String(modelId)]
  return hit ? clone(hit) : null
}

// snapshot 传 null 表示删除（回滚时用）
export function saveSettlement(modelId: number, snapshot: SettlementSnapshot | null): void {
  const all = readAll()
  if (snapshot === null) {
    delete all[String(modelId)]
  } else {
    all[String(modelId)] = clone(snapshot)
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  }
  memoryFallback = all
}

export function settlementStorageKey(): string {
  return STORAGE_KEY
}
