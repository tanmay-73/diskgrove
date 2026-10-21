import { cn } from '@/lib/utils'

export function SizeBar({
  ratio,
  className,
  color = 'rgb(76 155 255 / 0.35)'
}: {
  ratio: number
  className?: string
  color?: string
}) {
  const pct = Math.max(0, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100))
  return (
    <div
      className={cn('absolute inset-y-1 left-0 rounded-sm', className)}
      style={{ width: `${pct}%`, background: color }}
    />
  )
}

export function GrowBar({
  ratio,
  color,
  className,
  barClassName
}: {
  ratio: number
  color: string
  className?: string
  barClassName?: string
}) {
  const pct = Math.max(1, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100))
  return (
    <div className={cn('overflow-hidden rounded bg-secondary', className)}>
      <div
        className={cn('animate-bar h-full origin-left transition-[width] duration-500 ease-out', barClassName)}
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  )
}
