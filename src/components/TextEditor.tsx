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
              <strong>编辑原文后，{annotationCount} 条标注将按编辑前后原文逐段比对重新定位：</strong>
              原标注片段仍在、只是其前方或后方插删文字的，自动跟随到新位置；
              原片段被删除、或编辑直接触及标注区间（即使别处还有相同引文）时进入「待处理」，
              不会静默绑到同文副本上，可随时手动重新选择片段恢复。
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
