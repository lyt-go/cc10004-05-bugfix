import { useCallback, useEffect, useState } from 'react'

import {
  downloadEntries,
  isDuplicateReport,
  isTouchpointEligible,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  runBatchAction,
  touchpointBlockReason,
} from '@/api/local-service'
import type { BatchItemResult, EntryRow } from '@/data/types'

const meta = moduleMeta('touchpoint')
const columns = [
  "触点编号",
  "用户标识",
  "触点类型",
  "触点渠道",
  "触点时间",
  "会话标识",
  "落地页URL",
  "来源参数"
]
const actions = [
  "确认采集",
  "标记已清洗"
]
const statuses = [
  "草稿",
  "已采集",
  "已清洗"
]
const stats = [
  {
    "label": "触点记录总数",
    "value": 0
  },
  {
    "label": "今日采集量",
    "value": 0
  },
  {
    "label": "昨日采集量",
    "value": 0
  }
]
// 核查对象包含会话标识：把它放进筛选条件，方便按会话核对重复上报
const filterFields = ["触点编号", "用户标识", "触点渠道", "会话标识"]

export default function TouchpointView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [allRows, setAllRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batchAction, setBatchAction] = useState(actions[0])
  const [batchResults, setBatchResults] = useState<BatchItemResult[] | null>(null)

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      // 重复上报判定要基于全量触点，与结算口径一致，不能被当前筛选条件截断
      setAllRows(listEntries(meta.key).items)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '触点追踪列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  const allChecked = rows.length > 0 && rows.every((row) => selected.has(Number(row.id)))

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((row) => Number(row.id))))
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // 批量提交整组：每条单独返回结果，未通过的保持勾选，留给操作人逐条处理
  function submitBatch() {
    setErrorMessage('')
    setNotice('')
    const ids = rows.filter((row) => selected.has(Number(row.id))).map((row) => Number(row.id))
    if (ids.length === 0) {
      setErrorMessage('请先勾选要批量处理的触点记录')
      return
    }
    const result = runBatchAction(meta.key, ids, batchAction)
    setBatchResults(result.results)
    const failed = result.results.filter((item) => !item.ok)
    setSelected(new Set(failed.map((item) => item.id)))
    setNotice(
      result.ok
        ? `批量${batchAction}：${ids.length} 条全部通过`
        : `批量${batchAction}：通过 ${ids.length - failed.length} 条，未通过 ${failed.length} 条（已保留勾选，请逐条处理）`,
    )
    reload()
  }

  // 参与归因口径与结算完全一致：已清洗 + 有效会话 + 会话去重
  function eligibilityNote(row: EntryRow): string {
    if (!isTouchpointEligible(row)) {
      return `否（${touchpointBlockReason(row)}）`
    }
    if (isDuplicateReport(row, allRows)) {
      return '并入首次触达（同会话重复上报）'
    }
    return '是'
  }

  return (
    <section className="page" data-module="touchpoint">
      <header className="page-head">
        <div>
          <h2>触点追踪管理</h2>
          <p className="page-desc">记录用户与数据产品的所有交互触点，为归因分析和用户路径分析提供基础数据。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('触点记录登记入口尚未接入审批流')}>
            登记触点记录
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出触点追踪清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <div className="batch-bar">
        <span>已选 {selected.size} 条</span>
        <select value={batchAction} onChange={(event) => setBatchAction(event.target.value)}>
          {actions.map((action) => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
        <button className="btn primary" type="button" onClick={submitBatch}>批量提交</button>
        <button className="btn ghost" type="button" onClick={() => { setSelected(new Set()); setBatchResults(null) }}>
          清空选择
        </button>
        <span className="batch-hint">勾选多条后一次提交整组，每条单独返回结果</span>
      </div>

      {batchResults && (
        <ul className="batch-result-list">
          {batchResults.map((item) => (
            <li key={item.id} className={item.ok ? 'ok' : 'fail'}>
              #{item.id} {item.ok ? '通过' : '未通过'}：{item.message}
            </li>
          ))}
        </ul>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th className="checkbox-cell">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选" />
            </th>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>参与归因</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              <td className="checkbox-cell">
                <input
                  type="checkbox"
                  checked={selected.has(Number(row.id))}
                  onChange={() => toggleOne(Number(row.id))}
                  aria-label={`选择${String(row['触点编号'] ?? row.id)}`}
                />
              </td>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{eligibilityNote(row)}</td>
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 4}>暂无触点追踪数据，可先登记触点记录</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条触点追踪记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
