import { useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import {
  Expand,
  Gauge,
  Loader2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Volume1,
  Volume2,
  VolumeX
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { formatClock } from './viewers'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SEEK_STEP = 5

// Volume carries over from one previewed file to the next.
const sound = { volume: 1, muted: false }

type Media = HTMLVideoElement | HTMLAudioElement

// Where playback stands, handed between the preview player and its popup.
interface Playback {
  time: number
  playing: boolean
  rate: number
  loop: boolean
}

interface MediaPlayerProps {
  src: string
  kind: 'video' | 'audio'
  onLoadedMetadata?: (media: Media) => void
  onError: () => void
  // Shown above the controls for audio, where there is no picture.
  artwork?: ReactNode
  // Popup title; also enables the expand button for video.
  title?: string
  // Set on the popup player: where to pick up, and how to report back and close.
  resume?: Playback
  onSync?: (state: Playback) => void
  onCollapse?: () => void
}

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function clockOrDash(seconds: number) {
  return Number.isFinite(seconds) ? formatClock(seconds) : '--:--'
}

export function MediaPlayer({
  src,
  kind,
  onLoadedMetadata,
  onError,
  artwork,
  title,
  resume,
  onSync,
  onCollapse
}: MediaPlayerProps) {
  const mediaRef = useRef<Media | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(NaN)
  // While dragging the seek bar the thumb follows the pointer; the media only seeks on release.
  const [scrub, setScrub] = useState<number | null>(null)
  const [volume, setVolume] = useState(sound.volume)
  const [muted, setMuted] = useState(sound.muted)
  const [rate, setRate] = useState(resume?.rate ?? 1)
  const [loop, setLoop] = useState(resume?.loop ?? false)
  // Latest state reported by the popup, applied here when it closes.
  const [popout, setPopout] = useState<Playback | null>(null)
  const popoutState = useRef<Playback | null>(null)

  const media = () => mediaRef.current
  const seekable = Number.isFinite(duration) && duration > 0
  const isPopup = resume !== undefined
  const canExpand = kind === 'video' && (isPopup || title !== undefined)

  const sync = (patch: Partial<Playback> = {}) => {
    const m = media()
    if (!m || !onSync) return
    onSync({ time: m.currentTime, playing: !m.paused && !m.ended, rate: m.playbackRate, loop: m.loop, ...patch })
  }

  const togglePlay = () => {
    const m = media()
    if (!m) return
    if (m.paused || m.ended) void m.play().catch(() => undefined)
    else m.pause()
  }

  const seekTo = (seconds: number) => {
    const m = media()
    if (!m || !seekable) return
    m.currentTime = Math.min(Math.max(seconds, 0), duration)
    setTime(m.currentTime)
  }

  const changeVolume = (value: number) => {
    const m = media()
    if (!m) return
    m.volume = value
    m.muted = value === 0
  }

  const toggleMute = () => {
    const m = media()
    if (!m) return
    if (m.muted && m.volume === 0) m.volume = 0.5
    m.muted = !m.muted
  }

  const changeRate = (value: number) => {
    const m = media()
    if (m) m.playbackRate = value
  }

  const toggleLoop = () => {
    setLoop(!loop)
    sync({ loop: !loop })
  }

  const expand = () => {
    if (isPopup) return onCollapse?.()
    const m = media()
    if (!m) return
    const state = { time: m.currentTime, playing: !m.paused && !m.ended, rate: m.playbackRate, loop }
    m.pause()
    popoutState.current = state
    setPopout(state)
  }

  const collapse = () => {
    const state = popoutState.current
    const m = media()
    setPopout(null)
    if (!state || !m) return
    // The popup may have changed the volume; pick it up along with the position.
    m.volume = sound.volume
    m.muted = sound.muted
    m.playbackRate = state.rate
    setLoop(state.loop)
    seekTo(state.time)
    if (state.playing) void m.play().catch(() => undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Menus are portalled out of the player, and sliders and buttons own their own keys.
    const target = e.target as HTMLElement
    if (!e.currentTarget.contains(target) || target.getAttribute('role') === 'slider') return
    if (target !== e.currentTarget && (e.key === ' ' || e.key === 'Enter')) return
    const handlers: Record<string, () => void> = {
      ' ': togglePlay,
      k: togglePlay,
      ArrowLeft: () => seekTo(time - SEEK_STEP),
      ArrowRight: () => seekTo(time + SEEK_STEP),
      ArrowUp: () => changeVolume(Math.min(1, volume + 0.1)),
      ArrowDown: () => changeVolume(Math.max(0, volume - 0.1)),
      m: toggleMute,
      Home: () => seekTo(0),
      End: () => seekTo(duration),
      ...(canExpand ? { f: expand } : {})
    }
    const handler = handlers[e.key]
    if (!handler) return
    e.preventDefault()
    e.stopPropagation()
    handler()
  }

  const mediaProps = {
    src,
    preload: 'metadata',
    loop,
    onLoadedMetadata: (e: SyntheticEvent<Media>) => {
      const m = e.currentTarget
      m.volume = sound.volume
      m.muted = sound.muted
      setDuration(m.duration)
      if (resume) {
        m.currentTime = resume.time
        m.playbackRate = resume.rate
        if (resume.playing) void m.play().catch(() => undefined)
      }
      onLoadedMetadata?.(m)
    },
    onEmptied: () => {
      setPlaying(false)
      setEnded(false)
      setWaiting(false)
      setTime(0)
      setDuration(NaN)
    },
    onDurationChange: (e: SyntheticEvent<Media>) => setDuration(e.currentTarget.duration),
    onTimeUpdate: (e: SyntheticEvent<Media>) => {
      setTime(e.currentTarget.currentTime)
      sync()
    },
    onPlay: () => {
      setPlaying(true)
      setEnded(false)
      sync({ playing: true })
    },
    onPause: () => {
      setPlaying(false)
      sync({ playing: false })
    },
    onEnded: () => {
      setPlaying(false)
      setEnded(true)
      sync({ playing: false })
    },
    onWaiting: () => setWaiting(true),
    onPlaying: () => setWaiting(false),
    onCanPlay: () => setWaiting(false),
    onVolumeChange: (e: SyntheticEvent<Media>) => {
      sound.volume = e.currentTarget.volume
      sound.muted = e.currentTarget.muted
      setVolume(sound.volume)
      setMuted(sound.muted)
    },
    onRateChange: (e: SyntheticEvent<Media>) => {
      setRate(e.currentTarget.playbackRate)
      sync()
    },
    onError
  } as const

  const shownTime = scrub ?? time
  const silent = muted || volume === 0
  const VolumeIcon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const PlayIcon = playing ? Pause : ended ? RotateCcw : Play

  const controls = (
    <div className="flex flex-col gap-1 px-2.5 pb-1.5 pt-2">
      <div className="flex items-center gap-2 text-[11px] tabular text-muted-foreground">
        <span className="shrink-0 text-foreground">{clockOrDash(shownTime)}</span>
        <Slider
          aria-label="Seek"
          min={0}
          max={seekable ? duration : 1}
          step={0.1}
          value={[seekable ? shownTime : 0]}
          disabled={!seekable}
          onValueChange={([v]) => setScrub(v)}
          onValueCommit={([v]) => {
            seekTo(v)
            setScrub(null)
          }}
          className="min-w-0 flex-1 cursor-pointer [&_[role=slider]]:size-3.5"
        />
        <span className="shrink-0">{clockOrDash(duration)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-0.5">
        <Tip label={playing ? 'Pause (k)' : ended ? 'Replay (k)' : 'Play (k)'}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
            onClick={togglePlay}
          >
            <PlayIcon className={cn(!playing && !ended && 'fill-current')} />
          </Button>
        </Tip>
        <Tip label={silent ? 'Unmute (m)' : 'Mute (m)'}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={silent ? 'Unmute' : 'Mute'}
            onClick={toggleMute}
          >
            <VolumeIcon />
          </Button>
        </Tip>
        <Slider
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={[silent ? 0 : volume]}
          onValueChange={([v]) => changeVolume(v)}
          className="w-14 shrink-0 cursor-pointer [&_[role=slider]]:size-3"
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tip label={loop ? 'Loop on' : 'Loop off'}>
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-7', loop ? 'text-primary' : 'text-muted-foreground')}
              aria-label="Loop"
              aria-pressed={loop}
              onClick={toggleLoop}
            >
              <Repeat />
            </Button>
          </Tip>
          <DropdownMenu>
            <Tip label="Playback speed">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Playback speed ${rate}×`}
                  className={cn('h-7 gap-1 px-1.5 tabular', rate === 1 ? 'text-muted-foreground' : 'text-primary')}
                >
                  <Gauge />
                  {rate}×
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" className="min-w-28">
              <DropdownMenuLabel>Speed</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={String(rate)} onValueChange={(v) => changeRate(Number(v))}>
                {RATES.map((r) => (
                  <DropdownMenuRadioItem key={r} value={String(r)} className="tabular">
                    {r === 1 ? 'Normal' : `${r}×`}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {canExpand ? (
            <Tip label={isPopup ? 'Back to preview (f)' : 'Open in player (f)'}>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={isPopup ? 'Back to preview' : 'Open in player'}
                onClick={expand}
              >
                {isPopup ? <Minimize2 /> : <Expand />}
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>
    </div>
  )

  if (kind === 'audio') {
    return (
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {artwork}
        <div className="w-full overflow-hidden rounded-lg border bg-card shadow-sm">
          <audio ref={(el) => void (mediaRef.current = el)} {...mediaProps} />
          {controls}
        </div>
      </div>
    )
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !isPopup && 'border shadow-md'
      )}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        <video
          ref={(el) => void (mediaRef.current = el)}
          {...mediaProps}
          className="absolute inset-0 size-full cursor-pointer object-contain"
          onClick={togglePlay}
          onDoubleClick={canExpand ? expand : undefined}
        />
        {popout ? (
          <p className="pointer-events-none absolute text-xs text-white/70">Playing in the player window</p>
        ) : waiting && playing ? (
          <Loader2 className="pointer-events-none absolute size-8 animate-spin text-white/80" />
        ) : !playing ? (
          <button
            type="button"
            aria-label={ended ? 'Replay' : 'Play'}
            onClick={togglePlay}
            className="absolute flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-150 hover:scale-105 active:scale-95 animate-fade"
          >
            {ended ? <RotateCcw className="size-5" /> : <Play className="ml-0.5 size-5 fill-current" />}
          </button>
        ) : null}
      </div>
      {controls}
      {popout && title !== undefined ? (
        <Dialog open onOpenChange={(open) => !open && collapse()}>
          <DialogContent className="flex h-[88vh] w-[92vw] max-w-6xl flex-col gap-3 p-3 pt-2.5">
            <div className="min-w-0 pl-1 pr-8">
              <DialogTitle className="truncate text-sm" title={title}>
                {title}
              </DialogTitle>
              <DialogDescription className="sr-only">Video player</DialogDescription>
            </div>
            <div className="min-h-0 flex-1">
              <MediaPlayer
                src={src}
                kind="video"
                resume={popout}
                onSync={(state) => void (popoutState.current = state)}
                onCollapse={collapse}
                onError={() => {
                  collapse()
                  onError()
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
