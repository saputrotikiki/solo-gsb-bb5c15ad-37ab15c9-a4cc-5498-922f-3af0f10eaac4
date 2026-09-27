import { useEffect, useRef, type ReactNode } from 'react'
import type { ViewRect } from './TextView'

interface Props {
  /** rect 任一坐标为负值时，面板改为视口居中显示（用于不依附于选区的场景） */
  rect: ViewRect
  onClose: () => void
  children: ReactNode
}

/** 跟随选区 / 高亮位置的浮动面板，自动翻转避免超出视口 */
export function Popover({ rect, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // 延迟注册，避免触发弹出面板的那次 click 立刻把它关掉
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const centered = rect.top < 0 || rect.left < 0

  if (centered) {
    return (
      <>
        <div className="popover-backdrop" onMouseDown={onClose} />
        <div ref={ref} className="popover popover-center">
          {children}
        </div>
      </>
    )
  }

  const POPOVER_WIDTH = 360
  const margin = 8
  let left = rect.left
  if (left + POPOVER_WIDTH + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - POPOVER_WIDTH - margin)
  }
  const placeBelow = rect.bottom + margin + 260 < window.innerHeight

  const style: React.CSSProperties = {
    position: 'fixed',
    left,
    width: POPOVER_WIDTH,
    zIndex: 50,
  }
  if (placeBelow) {
    style.top = rect.bottom + margin
  } else {
    style.bottom = window.innerHeight - rect.top + margin
  }

  return (
    <div ref={ref} className="popover" style={style}>
      {children}
    </div>
  )
}
