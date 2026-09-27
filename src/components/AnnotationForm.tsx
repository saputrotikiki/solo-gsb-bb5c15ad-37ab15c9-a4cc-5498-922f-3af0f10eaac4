import { useState } from 'react'
import type { Annotation } from '../types'
import { TagEditor } from './TagEditor'

interface BaseProps {
  allTags: string[]
  onCancel: () => void
}

interface CreateProps extends BaseProps {
  mode: 'create'
  quote: string
  onCreate: (data: { note: string; tags: string[] }) => void
}

interface EditProps extends BaseProps {
  mode: 'edit'
  annotation: Annotation
  onSave: (data: { note: string; tags: string[] }) => void
  onDelete: () => void
}

type Props = CreateProps | EditProps

export function AnnotationForm(props: Props) {
  const existing = props.mode === 'edit' ? props.annotation : undefined
  const [note, setNote] = useState(existing?.note ?? '')
  const [tags, setTags] = useState<string[]>(existing?.tags ?? [])
  const status = existing?.status

  return (
    <form
      className="annotation-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (props.mode === 'create') props.onCreate({ note, tags })
        else props.onSave({ note, tags })
      }}
    >
      <div className="form-title">
        {props.mode === 'create' ? '新标注' : '编辑标注'}
        {status === 'pending' && (
          <span className="status-pill status-pending">待处理</span>
        )}
      </div>
      <blockquote className="form-quote">
        {props.mode === 'create' ? props.quote : existing?.quote ?? ''}
      </blockquote>
      <label className="form-label">标签</label>
      <TagEditor tags={tags} onChange={setTags} suggestions={props.allTags} />
      <label className="form-label">备注</label>
      <textarea
        className="form-note"
        rows={4}
        autoFocus
        value={note}
        placeholder="记录你的解读、出处、疑问……"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="form-actions">
        {props.mode === 'edit' && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm('确定删除这条标注吗？')) props.onDelete()
            }}
          >
            删除
          </button>
        )}
        <span className="form-spacer" />
        <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary">
          {props.mode === 'create' ? '保存标注' : '保存修改'}
        </button>
      </div>
    </form>
  )
}
