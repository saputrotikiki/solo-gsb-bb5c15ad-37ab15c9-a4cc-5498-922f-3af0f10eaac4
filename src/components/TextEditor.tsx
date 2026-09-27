import { useEffect, useState } from 'react'

interface Props {
  initialTitle: string
  initialText: string
  annotationCount: number
  onCancel: () => void
  onApply: (title: string, text: string) => void
}

export function TextEditor({
  initialTitle,
  initialText,
  annotationCount,
  onCancel,
  onApply,
}: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [text, setText] = useState(initialText)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const changed = text !== initialText

  return (
    <div className="editor-pane">
      <div className="editor-warning">
        {annotationCount > 0 ? (
          changed ? (
            <>
              <strong>编辑原文后，{annotationCount} 条标注将按锚点规则重新定位：</strong>
              旧位置前后 200 字内精确匹配 → 全文唯一匹配 → 前后文相同字符数评分。
              最高分并列或得分为 0 的标注会进入「待处理」，不会静默误绑。
            </>
          ) : (
            <>正文未改动，保存后标注位置不会变化。标题可自由修改。</>
          )
        ) : (
          <>粘贴或输入原文，完成后点击「完成编辑」。</>
        )}
      </div>
      <input
        className="editor-title-input"
        value={title}
        placeholder="文档标题"
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="editor-textarea"
        value={text}
        autoFocus
        placeholder="在此粘贴原文……"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="editor-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <span className="form-spacer" />
        <span className="editor-meta">正文 {text.length} 字</span>
        <button
          className="btn btn-primary"
          onClick={() => onApply(title.trim() || '未命名文档', text)}
        >
          完成编辑
        </button>
      </div>
    </div>
  )
}
