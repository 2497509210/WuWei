import { useEffect, useRef, useState } from "react";
import { exportInventory, type ExportFilter, type ExportFormat, type ExportInput, type ExportScope } from "../api/exports";
import { Modal } from "./Modal";
import "../styles/export.css";

export function ExportDialog({ filter, selectedIds, onClose }: {
  filter: ExportFilter; selectedIds: string[]; onClose: () => void;
}) {
  const [scope, setScope] = useState<ExportScope>("filtered");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState<{ key: string; url: string; filename: string; format: ExportFormat } | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const objectUrl = useRef<string | null>(null);
  const selectedValid = selectedIds.length > 0 && selectedIds.length <= 100 && new Set(selectedIds).size === selectedIds.length;
  const key = JSON.stringify([scope, format, filter, selectedIds]);
  const keyRef = useRef(key); keyRef.current = key;

  function releaseFile() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }
  useEffect(() => {
    sequence.current++; request.current?.abort(); request.current = null;
    releaseFile(); setDownload(null); setBusy(false); setError("");
  }, [key]);
  useEffect(() => () => {
    sequence.current++; request.current?.abort(); releaseFile();
  }, []);

  function cancel() {
    sequence.current++; request.current?.abort(); request.current = null;
    setBusy(false); setError("已取消导出，可以重新生成");
  }

  async function generate() {
    if (request.current || (scope === "selected" && !selectedValid)) return;
    const controller = new AbortController(); request.current = controller;
    const owner = ++sequence.current;
    const capturedKey = key;
    setBusy(true); setError(""); releaseFile(); setDownload(null);
    const input: ExportInput = scope === "filtered"
      ? { format, scope, status: filter.status, ...(filter.q ? { q: filter.q } : {}), ...(filter.compartmentId ? { compartment_id: filter.compartmentId } : {}) }
      : scope === "selected" ? { format, scope, ids: [...selectedIds] } : { format, scope };
    try {
      const result = await exportInventory(input, controller.signal);
      if (owner !== sequence.current || capturedKey !== keyRef.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(result.blob); objectUrl.current = url;
      setDownload({ key: capturedKey, url, filename: result.filename, format: result.format });
    } catch (error) {
      if (owner === sequence.current && capturedKey === keyRef.current) setError(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      if (owner === sequence.current) { request.current = null; setBusy(false); }
    }
  }

  const file = download?.key === key ? download : null;
  return <Modal title="导出清单" onClose={onClose} busy={busy}>
    <form className="export-dialog inventory-form" onSubmit={event => { event.preventDefault(); void generate(); }}>
      <fieldset disabled={busy} className="export-scope">
        <legend>导出范围</legend>
        <label><input type="radio" name="export-scope" checked={scope === "filtered"} onChange={() => setScope("filtered")} />当前筛选结果</label>
        <label><input type="radio" name="export-scope" checked={scope === "selected"} disabled={!selectedValid} onChange={() => setScope("selected")} />所选物品（{selectedIds.length} 件）</label>
        <label><input type="radio" name="export-scope" checked={scope === "all"} onChange={() => setScope("all")} />全部物品（含归档）</label>
      </fieldset>
      <p className="export-range" role="status">{scope === "filtered"
        ? `范围：${filter.status === "archived" ? "已归档" : "在用"}${filter.q ? ` · 搜索“${filter.q}”` : " · 不限关键词"}${filter.compartmentId ? " · 当前隔层" : " · 全部位置"}`
        : scope === "selected" ? `范围：已选中的 ${selectedIds.length} 件物品` : "范围：本家庭全部在用和已归档物品"}</p>
      {!selectedValid && <p className="inventory-muted">所选物品导出需要先选择 1–100 件物品。</p>}
      <label>文件格式<select aria-label="文件格式" value={format} disabled={busy} onChange={event => setFormat(event.target.value as ExportFormat)}>
        <option value="csv">CSV（表格软件）</option><option value="json">JSON（保留字段结构）</option>
      </select></label>
      <p className="inventory-muted">只导出清单，不含照片文件。最多 10000 条，超出时会提示缩小范围；清单不是完整备份，本轮不提供导入。</p>
      {error && <p className="inventory-error" role="alert">{error}</p>}
      {busy ? <div className="inventory-actions"><span role="status">正在生成清单…</span><button type="button" onClick={cancel}>取消导出</button></div>
        : <button type="submit" className="inventory-primary" disabled={scope === "selected" && !selectedValid}>生成导出文件</button>}
      {file && <div className="export-ready"><p role="status">文件已生成，点击下方链接保存。</p>
        <a href={file.url} download={file.filename} className="export-download">下载 {file.format.toUpperCase()} 清单</a>
        <p className="inventory-muted">手机浏览器若打开预览，请使用分享菜单中的“存储到文件”。关闭弹窗或更改范围后需重新生成。</p>
      </div>}
    </form>
  </Modal>;
}
