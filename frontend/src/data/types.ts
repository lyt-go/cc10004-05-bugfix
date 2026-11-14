/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type ActionOptions = {
  // 并发控制：调用方读到的记录版本号，写入前校验，不一致就拒绝，旧草稿不得覆盖已结算快照
  expectedRevision?: number
}

export type BatchItemResult = {
  id: number
  ok: boolean
  message: string
}

export type BatchResult = {
  ok: boolean
  results: BatchItemResult[]
}

export type ChannelWeight = {
  渠道: string
  触达次数: number
  权重: number
}

// 归因结算快照：模型发布/重算时生成，模型下线后冻结保留，不再新增结算
export type SettlementSnapshot = {
  modelId: number
  模型编号: string
  version: number
  settledAt: string
  frozen: boolean
  口径: {
    触点总数: number
    准入触点: number
    去重后触达: number
  }
  渠道明细: ChannelWeight[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
