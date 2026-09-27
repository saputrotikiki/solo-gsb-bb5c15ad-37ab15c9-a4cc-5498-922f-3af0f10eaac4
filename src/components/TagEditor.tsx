import { useId, useState } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
  suggestions: string[]
  placeholder?: string
}

export function TagEditor({ tags, onChange, suggestions, placeholder }: Props) {
  const [input, setInput] = useState('')
  // 弹层表单与侧栏批量预览可能同时挂载 TagEditor，datalist id 必须唯一
  const reactId = useId()
  const listId = `tag-suggestions-${reactId}`

  const add = (raw: string) => {
    const t = raw.trim().replace(/^#/, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setInput('')
  }

  const remaining = suggestions.filter((s) => !tags.includes(s))

  return (
    <div className="tag-editor">
      <div className="tag-chips">
        {tags.map((t) => (
          <span className="tag-chip" key={t}>
            #{t}
            <button
              type="button"
              className="tag-chip-x"
              aria-label={`移除标签 ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={input}
          list={listId}
          placeholder={placeholder ?? '输入标签后回车，逗号也可分隔'}
          onChange={(e) => {
            const v = e.target.value
            if (v.includes(',')) {
              v.split(',').forEach((part) => part.trim() && add(part))
            } else {
              setInput(v)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(input)
            } else if (e.key === 'Backspace' && !input && tags.length) {
              onChange(tags.slice(0, -1))
            }
          }}
        />
        <datalist id={listId}>
          {remaining.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {remaining.length > 0 && (
        <div className="tag-suggest-row">
          {remaining.slice(0, 8).map((s) => (
            <button
              type="button"
              key={s}
              className="tag-suggest"
              onClick={() => add(s)}
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
