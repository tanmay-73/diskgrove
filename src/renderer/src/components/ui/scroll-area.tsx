import * as React from 'react'
import { cn } from '@/lib/utils'

type ScrollAreaProps = React.ComponentPropsWithoutRef<'div'> & {
  /** Axes that get a scrollbar; content can only scroll along these. */
  orientation?: 'vertical' | 'horizontal' | 'both'
  /** The scrolling element, e.g. for virtualizers or keyboard handling. */
  viewportRef?: React.Ref<HTMLDivElement>
  viewportClassName?: string
  viewportProps?: Omit<React.ComponentPropsWithoutRef<'div'>, 'className'>
}

const OVERFLOW = {
  vertical: 'overflow-x-hidden overflow-y-auto',
  horizontal: 'overflow-x-auto overflow-y-hidden',
  both: 'overflow-auto'
} as const

// Native scrolling with styled scrollbars (see `.scroll-viewport` in index.css). A JS scroll area such
// as Radix's registers a non-passive document wheel listener, which pins every wheel scroll to the main
// thread and drops frames on high refresh rate displays whenever React is rendering.
// The root is a flex column so the viewport fills a sized root and also respects a bare max-height.
// Children sit in one block wrapper so `[&>div]:` viewport classes can style the content box.
const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, orientation = 'both', viewportRef, viewportClassName, viewportProps, ...props }, ref) => (
    <div ref={ref} className={cn('relative isolate flex flex-col overflow-hidden', className)} {...props}>
      <div
        ref={viewportRef}
        className={cn(
          'scroll-viewport min-h-0 w-full flex-auto rounded-[inherit]',
          OVERFLOW[orientation],
          viewportClassName
        )}
        {...viewportProps}
      >
        <div className="min-w-full">{children}</div>
      </div>
    </div>
  )
)
ScrollArea.displayName = 'ScrollArea'

export { ScrollArea }
