import { Fragment, useCallback, useEffect, useState } from 'react'

import {
  downloadEntries,
  listEntries,
  loadSettlement,
  moduleMeta,
  resettleModel,
  runAction as applyAction,
  runBatchAction,
} from '@/api/local-service'
import type { BatchItemResult, EntryRow, SettlementSnapshot } from '@/data/types'

const meta = moduleMeta('attribution')
const columns = [
  "模型编号",
  "模型名称",
  "归因算法",
  "回溯窗口天",
  "首次权重",
  "末次权重",
  "衰减因子",
  "渠道权重"
]
const actions = [
  "提交模型评审",
  "发布模型",
  "下线模型"
]
const statuses = [
  "草稿",
  "模型评审中",
  "已发布",
  "已下线"
]
const stats = [
  {
    "label": "归因模型总数",
    "value": 0
  },
  {
    "label": "已发布模型",
    "value": 0
  },
  {
    "label": "模型评审中",
    "value": 0
  }
]
const filterFields = ["模型编号", "模型名称", "归因算法"]

export default function AttributionView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batchAction, setBatchAction] = useState(actions[0])
  const [batchResults, setBatchResults] = useState<BatchItemResult[] | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [settlement, setSettlement] = useState<SettlementSnapshot | null>(null)

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '归因分析列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function refreshDetail(id: number) {
    setSettlement(loadSettlement(id))
  }

  function toggleDetail(row: EntryRow) {
    const id = Number(row.id)
    if (expandedId === id) {
      setExpandedId(null)
      setSettlement(null)
      return
    }
    setExpandedId(id)
    refreshDetail(id)
  }

  // 行级动作带上读到的记录版本号：并发发布同一模型时只有一方能成功
  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action, {
      expectedRevision: Number(row.revision ?? 0),
    })
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
    if (expandedId === Number(row.id)) {
      refreshDetail(Number(row.id))
    }
  }

  function resettle(row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = resettleModel(Number(row.id), Number(row.revision ?? 0))
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
    refreshDetail(Number(row.id))
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
    const targets = rows.filter((row) => selected.has(Number(row.id)))
    if (targets.length === 0) {
      setErrorMessage('请先勾选要批量处理的归因模型')
      return
    }
    const revisions = Object.fromEntries(targets.map((row) => [Number(row.id), Number(row.revision ?? 0)]))
    const result = runBatchAction(meta.key, targets.map((row) => Number(row.id)), batchAction, revisions)
    setBatchResults(result.results)
    const failed = result.results.filter((item) => !item.ok)
    setSelected(new Set(failed.map((item) => item.id)))
    setNotice(
      result.ok
        ? `批量${batchAction}：${targets.length} 条全部通过`
        : `批量${batchAction}：通过 ${targets.length - failed.length} 条，未通过 ${failed.length} 条（已保留勾选，请逐条处理）`,
    )
    reload()
    if (expandedId !== null) {
      refreshDetail(expandedId)
    }
  }

  return (
    <section className="page" data-module="attribution">
      <header className="page-head">
        <div>
          <h2>归因分析管理</h2>
          <p className="page-desc">定义多触点归因模型，支持首次/末次/线性/时间衰减/U型等多种归因算法。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('归因模型登记入口尚未接入审批流')}>
            登记归因模型
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出归因分析清单
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
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={String(row.id)}>
              <tr>
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={selected.has(Number(row.id))}
                    onChange={() => toggleOne(Number(row.id))}
                    aria-label={`选择${String(row['模型编号'] ?? row.id)}`}
                  />
                </td>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                  <button className="link" type="button" onClick={() => toggleDetail(row)}>
                    {expandedId === Number(row.id) ? '收起详情' : '归因详情'}
                  </button>
                </td>
              </tr>
              {expandedId === Number(row.id) && (
                <tr className="detail-row">
                  <td colSpan={columns.length + 3}>
                    {settlement ? (
                      <div className="detail-panel">
                        <p className="detail-meta">
                          结算版本 v{settlement.version} ｜ 结算时间 {new Date(settlement.settledAt).toLocaleString()} ｜{' '}
                          {settlement.frozen
                            ? '已冻结：模型已下线，停止新增结算，以下为历史渠道归因明细'
                            : '当前生效'}
                        </p>
                        <p className="detail-meta">
                          结算口径：触点 {settlement.口径.触点总数} 条 → 准入（已清洗且会话有效）{settlement.口径.准入触点} 条 → 会话去重后 {settlement.口径.去重后触达} 次触达
                        </p>
                        <table className="data-table">
                          <thead>
                            <tr><th>触点渠道</th><th>触达次数</th><th>渠道权重</th></tr>
                          </thead>
                          <tbody>
                            {settlement.渠道明细.map((item) => (
                              <tr key={item.渠道}>
                                <td>{item.渠道}</td>
                                <td>{item.触达次数}</td>
                                <td>{(item.权重 * 100).toFixed(1)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!settlement.frozen && String(row.status) === '已发布' && (
                          <button className="btn" type="button" onClick={() => resettle(row)}>
                            重新结算
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="detail-panel detail-empty">
                        {String(row.status) === '已下线'
                          ? '模型已下线，无历史结算快照。'
                          : '模型发布时自动按触点结算生成渠道归因明细；当前状态暂无结算结果。'}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无归因分析数据，可先登记归因模型</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条归因分析记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
