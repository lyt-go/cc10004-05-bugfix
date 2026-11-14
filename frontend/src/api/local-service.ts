import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { getSettlement, saveSettlement } from '@/data/settlement-store'
import type {
  ActionOptions,
  ActionResult,
  BatchItemResult,
  BatchResult,
  ChannelWeight,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SettlementSnapshot,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const ATTRIBUTION_KEY = 'attribution'
const TOUCHPOINT_KEY = 'touchpoint'
const CLEANED_STATUS = '已清洗'

// 触点状态机：只能沿 草稿 → 已采集 → 已清洗 往前走，不允许跳级
const TOUCHPOINT_FLOW: Record<string, string> = {
  确认采集: '草稿',
  标记已清洗: '已采集',
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------------------------------------------------------------------------
// 触点准入与去重：触点列表的「参与归因」标识和归因结算共用同一套口径，
// 两边都从这里的函数取数，避免一处改了一处没改导致结果对不上。
// ---------------------------------------------------------------------------

// 有效会话：会话标识非空。空会话标识的记录不参与归因。
export function isSessionValid(row: EntryRow): boolean {
  return String(row['会话标识'] ?? '').trim() !== ''
}

// 触点准入：只有「已清洗」且会话有效的触点可以参与归因结算
export function isTouchpointEligible(row: EntryRow): boolean {
  return String(row.status) === CLEANED_STATUS && isSessionValid(row)
}

// 不能参与归因的原因（用于触点列表展示）
export function touchpointBlockReason(row: EntryRow): string {
  if (String(row.status) !== CLEANED_STATUS) {
    return `未清洗（当前${String(row.status)}）`
  }
  if (!isSessionValid(row)) {
    return '缺少有效会话标识'
  }
  return ''
}

// 到达顺序：先比触点时间，并列再比记录 id
function arrivalOrder(row: EntryRow): [string, number] {
  return [String(row['触点时间'] ?? ''), Number(row.id)]
}

function arrivalKey(row: EntryRow): string {
  return `${String(row['会话标识'] ?? '')}::${String(row['触点编号'] ?? '')}`
}

// 会话去重：同一会话内重复上报的同一触点（会话标识 + 触点编号）只算一次触达，
// 以首次到达为准（触点时间最早，并列取 id 最小）。
export function dedupeTouchpoints(rows: EntryRow[]): EntryRow[] {
  const firstByKey = new Map<string, EntryRow>()
  for (const row of rows) {
    const key = arrivalKey(row)
    const existing = firstByKey.get(key)
    if (!existing) {
      firstByKey.set(key, row)
      continue
    }
    const [time, id] = arrivalOrder(row)
    const [firstTime, firstId] = arrivalOrder(existing)
    if (time < firstTime || (time === firstTime && id < firstId)) {
      firstByKey.set(key, row)
    }
  }
  return [...firstByKey.values()]
}

// 这条记录是不是同会话里的重复上报（已被首次到达的那条吸收）
export function isDuplicateReport(row: EntryRow, all: EntryRow[]): boolean {
  if (!isTouchpointEligible(row)) {
    return false
  }
  const key = arrivalKey(row)
  const [time, id] = arrivalOrder(row)
  return all.some((other) => {
    if (Number(other.id) === Number(row.id) || !isTouchpointEligible(other)) {
      return false
    }
    if (arrivalKey(other) !== key) {
      return false
    }
    const [otherTime, otherId] = arrivalOrder(other)
    return otherTime < time || (otherTime === time && otherId < id)
  })
}

// 渠道权重：按去重后的触达次数在渠道间均分（线性口径）
export function computeChannelWeights(touches: EntryRow[]): ChannelWeight[] {
  const counts = new Map<string, number>()
  for (const touch of touches) {
    const channel = String(touch['触点渠道'] ?? '').trim() || '未标记渠道'
    counts.set(channel, (counts.get(channel) ?? 0) + 1)
  }
  const total = touches.length
  return [...counts.entries()]
    .map(([渠道, 触达次数]) => ({ 渠道, 触达次数, 权重: 触达次数 / total }))
    .sort((a, b) => b.触达次数 - a.触达次数 || a.渠道.localeCompare(b.渠道))
}

// 结算口径：触点记录 → 准入（已清洗 + 有效会话）→ 会话去重 → 渠道权重
function buildSettlementSnapshot(
  model: EntryRow,
): { ok: true; snapshot: Omit<SettlementSnapshot, 'version' | 'settledAt' | 'frozen'> } | { ok: false; message: string } {
  const all = listRows(TOUCHPOINT_KEY)
  const eligible = all.filter(isTouchpointEligible)
  const touches = dedupeTouchpoints(eligible)
  if (touches.length === 0) {
    return {
      ok: false,
      message: '没有可参与结算的有效触点（需已清洗且会话标识有效），已保留上一个完整结果',
    }
  }
  return {
    ok: true,
    snapshot: {
      modelId: Number(model.id),
      模型编号: String(model['模型编号'] ?? ''),
      口径: {
        触点总数: all.length,
        准入触点: eligible.length,
        去重后触达: touches.length,
      },
      渠道明细: computeChannelWeights(touches),
    },
  }
}

// ---------------------------------------------------------------------------
// 归因模型状态流转：结算写入与模型状态更新在同一事务里完成，
// 任一步失败整体回滚，保留上一个完整结果。
// ---------------------------------------------------------------------------

function commitAttribution(
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  settlement: { modelId: number; next: SettlementSnapshot | null } | null,
  successMessage: string,
): ActionResult {
  const previousSettlement = settlement ? getSettlement(settlement.modelId) : null
  try {
    if (settlement) {
      saveSettlement(settlement.modelId, settlement.next)
    }
    const nextRows = [...rows]
    nextRows[index] = updated
    saveRows(ATTRIBUTION_KEY, nextRows)
  } catch (error) {
    // 回滚：结算快照和模型状态都恢复到写入前，不让半截结果落库
    try {
      if (settlement) {
        saveSettlement(settlement.modelId, previousSettlement)
      }
      saveRows(ATTRIBUTION_KEY, rows)
    } catch {
      // 回滚本身失败时至少返回失败，让操作人重试
    }
    const reason = error instanceof Error ? error.message : '存储异常'
    return { ok: false, message: `结算写入失败，已回滚并保留上一个完整结果（${reason}）` }
  }
  return { ok: true, message: successMessage }
}

function checkRevision(model: EntryRow, expectedRevision?: number): ActionResult | null {
  const revision = Number(model.revision ?? 0)
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return {
      ok: false,
      message: `归因模型已被并发更新（当前版本 v${revision}），请刷新后重试；旧草稿不得覆盖已结算快照`,
    }
  }
  return null
}

function publishAttribution(
  rows: EntryRow[],
  index: number,
  model: EntryRow,
  revision: number,
): ActionResult {
  const status = String(model.status)
  if (status === '已发布') {
    return { ok: false, message: '归因模型已是「已发布」，旧草稿不得覆盖已结算快照；如需按最新触点重算请使用「重新结算」' }
  }
  if (status === '已下线') {
    return { ok: false, message: '归因模型已下线，停止新增结算，不能重新发布' }
  }
  const built = buildSettlementSnapshot(model)
  if (!built.ok) {
    return { ok: false, message: built.message }
  }
  const modelId = Number(model.id)
  const previous = getSettlement(modelId)
  const snapshot: SettlementSnapshot = {
    ...built.snapshot,
    version: (previous?.version ?? 0) + 1,
    settledAt: new Date().toISOString(),
    frozen: false,
  }
  const updated: EntryRow = { ...model, status: '已发布', pending: false, abnormal: false, revision: revision + 1 }
  return commitAttribution(
    rows,
    index,
    updated,
    { modelId, next: snapshot },
    `归因模型已发布并完成结算 v${snapshot.version}：触点 ${snapshot.口径.触点总数} 条 → 准入 ${snapshot.口径.准入触点} 条 → 会话去重后 ${snapshot.口径.去重后触达} 次触达`,
  )
}

function offlineAttribution(
  rows: EntryRow[],
  index: number,
  model: EntryRow,
  revision: number,
): ActionResult {
  const status = String(model.status)
  if (status === '已下线') {
    return { ok: false, message: '归因模型已经是「已下线」，不用重复操作' }
  }
  if (status !== '已发布') {
    return { ok: false, message: `归因模型当前状态「${status}」，只有已发布的模型才能下线` }
  }
  const modelId = Number(model.id)
  let snapshot = getSettlement(modelId)
  if (!snapshot) {
    // 已发布但还没有快照的历史数据：下线前按当前口径补一次结算，避免抹掉渠道归因明细
    const built = buildSettlementSnapshot(model)
    if (built.ok) {
      snapshot = { ...built.snapshot, version: 1, settledAt: new Date().toISOString(), frozen: false }
    }
  }
  const frozen = snapshot ? { ...snapshot, frozen: true } : null
  const updated: EntryRow = { ...model, status: '已下线', pending: false, abnormal: true, revision: revision + 1 }
  return commitAttribution(
    rows,
    index,
    updated,
    { modelId, next: frozen },
    '归因模型已下线：停止新增结算，历史渠道归因明细已保留',
  )
}

function runAttributionAction(id: number, action: string, expectedRevision?: number): ActionResult {
  const rows = listRows(ATTRIBUTION_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的归因模型` }
  }
  const model = rows[index]
  const conflict = checkRevision(model, expectedRevision)
  if (conflict) {
    return conflict
  }
  const revision = Number(model.revision ?? 0)
  switch (action) {
    case '提交模型评审': {
      if (String(model.status) !== '草稿') {
        return { ok: false, message: `归因模型当前状态「${String(model.status)}」，只有草稿能提交模型评审` }
      }
      const updated: EntryRow = { ...model, status: '模型评审中', pending: true, abnormal: false, revision: revision + 1 }
      return commitAttribution(rows, index, updated, null, '归因模型已提交模型评审，当前状态「模型评审中」')
    }
    case '发布模型':
      return publishAttribution(rows, index, model, revision)
    case '下线模型':
      return offlineAttribution(rows, index, model, revision)
    default:
      return { ok: false, message: `归因模型没有登记「${action}」这个动作` }
  }
}

// 已发布模型按最新触点重新结算：结算版本递增，快照与记录版本同事务写入
export function resettleModel(id: number, expectedRevision?: number): ActionResult {
  const rows = listRows(ATTRIBUTION_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的归因模型` }
  }
  const model = rows[index]
  const conflict = checkRevision(model, expectedRevision)
  if (conflict) {
    return conflict
  }
  const status = String(model.status)
  if (status === '已下线') {
    return { ok: false, message: '归因模型已下线，停止新增结算，历史渠道归因明细保持不变' }
  }
  if (status !== '已发布') {
    return { ok: false, message: `归因模型当前状态「${status}」，只有已发布的模型才能重新结算` }
  }
  const built = buildSettlementSnapshot(model)
  if (!built.ok) {
    return { ok: false, message: built.message }
  }
  const modelId = Number(model.id)
  const previous = getSettlement(modelId)
  const snapshot: SettlementSnapshot = {
    ...built.snapshot,
    version: (previous?.version ?? 0) + 1,
    settledAt: new Date().toISOString(),
    frozen: false,
  }
  const revision = Number(model.revision ?? 0)
  const updated: EntryRow = { ...model, revision: revision + 1 }
  return commitAttribution(
    rows,
    index,
    updated,
    { modelId, next: snapshot },
    `已按最新触点重新结算，结算版本 v${snapshot.version}：触点 ${snapshot.口径.触点总数} 条 → 准入 ${snapshot.口径.准入触点} 条 → 会话去重后 ${snapshot.口径.去重后触达} 次触达`,
  )
}

// 读取模型的结算快照：已发布模型若没有快照（历史数据），按当前口径补一次结算
export function loadSettlement(modelId: number): SettlementSnapshot | null {
  const existing = getSettlement(modelId)
  if (existing) {
    return existing
  }
  const model = listRows(ATTRIBUTION_KEY).find((row) => Number(row.id) === modelId)
  if (!model || String(model.status) !== '已发布') {
    return null
  }
  const built = buildSettlementSnapshot(model)
  if (!built.ok) {
    return null
  }
  const snapshot: SettlementSnapshot = {
    ...built.snapshot,
    version: 1,
    settledAt: new Date().toISOString(),
    frozen: false,
  }
  saveSettlement(modelId, snapshot)
  return snapshot
}

// ---------------------------------------------------------------------------
// 通用动作与批量提交
// ---------------------------------------------------------------------------

export function runAction(key: string, id: number, action: string, options: ActionOptions = {}): ActionResult {
  if (key === ATTRIBUTION_KEY) {
    return runAttributionAction(id, action, options.expectedRevision)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 触点状态机：只能沿 草稿 → 已采集 → 已清洗 逐级流转
  const requiredFrom = key === TOUCHPOINT_KEY ? TOUCHPOINT_FLOW[action] : undefined
  if (requiredFrom && current !== requiredFrom) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」，需先处于「${requiredFrom}」才能${action}` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 批量提交：一次提交整组，每条单独执行、单独返回结果，未通过的不影响其他条目
export function runBatchAction(
  key: string,
  ids: number[],
  action: string,
  revisions: Record<number, number> = {},
): BatchResult {
  const results: BatchItemResult[] = ids.map((id) => {
    const result = runAction(key, id, action, { expectedRevision: revisions[id] })
    return { id, ok: result.ok, message: result.message }
  })
  return { ok: results.every((item) => item.ok), results }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
