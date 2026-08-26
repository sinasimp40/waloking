import React, { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CalendarDays, Megaphone, X } from 'lucide-react'

function getImageSource(image) {
  if (!image) return ''
  if (typeof image === 'string') return image
  return image.url || image.src || image.path || ''
}

export default function AnnouncementDetailModal({ announcement, image, accent, onClose }) {
  const color = announcement?.color || accent || '#ff6a00'
  const title = announcement?.title || 'Announcement'
  const body = announcement?.body || announcement?.content || 'There is no additional information for this announcement.'
  const imageSource = getImageSource(image || announcement?.image)

  useEffect(() => {
    if (!announcement) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [announcement, onClose])

  const closeModal = (event) => {
    event?.preventDefault()
    event?.stopPropagation()
    onClose?.()
  }

  return (
    <AnimatePresence>
      {announcement && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[210] flex items-center justify-center p-4 sm:p-7"
          style={{ background: 'rgba(4, 5, 7, 0.84)', backdropFilter: 'blur(12px)' }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(event) }}
          onClick={(event) => { if (event.target === event.currentTarget) closeModal(event) }}
        >
          <motion.article
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.985 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="announcement-detail-title"
            aria-describedby="announcement-detail-body"
            className="relative w-full max-w-xl max-h-[calc(100dvh-32px)] overflow-y-auto rounded-[20px]"
            style={{
              background: '#111214',
              border: `1px solid ${color}55`,
              boxShadow: `0 28px 90px rgba(0,0,0,0.72), 0 0 42px ${color}16`,
              WebkitAppRegion: 'no-drag',
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close announcement details"
              onPointerDownCapture={closeModal}
              onMouseDownCapture={closeModal}
              onClickCapture={closeModal}
              className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-lg px-3 py-2 text-[9px] font-black uppercase tracking-[0.16em] transition-colors hover:bg-black/60"
              style={{
                color: '#fff',
                background: 'rgba(8, 9, 10, 0.76)',
                border: '1px solid rgba(255,255,255,0.28)',
                WebkitAppRegion: 'no-drag',
              }}
            >
              <X size={12} />
              Close
            </button>

            <header
              className="relative min-h-[218px] overflow-hidden"
              style={{
                backgroundImage: imageSource
                  ? `linear-gradient(90deg, rgba(17,18,20,0.98) 0%, rgba(17,18,20,0.8) 48%, rgba(17,18,20,0.22) 100%), linear-gradient(0deg, rgba(17,18,20,0.94), transparent 65%), url("${imageSource}")`
                  : `radial-gradient(circle at 82% 10%, ${color}42, transparent 38%), linear-gradient(145deg, ${color}26, #111214 68%)`,
                backgroundPosition: 'center',
                backgroundSize: 'cover',
              }}
            >
              <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(125deg, ${color}22, transparent 54%)` }} />
              <div className="absolute left-0 top-0 h-full w-1" style={{ background: color, boxShadow: `0 0 18px ${color}aa` }} />
              <div className="relative z-10 flex min-h-[218px] flex-col justify-end p-6 pt-16">
                <div className="mb-3 flex items-center gap-2 text-[8px] font-black uppercase tracking-[0.2em]" style={{ color }}>
                  <Megaphone size={12} />
                  Dispatch / Announcement
                </div>
                <h2 id="announcement-detail-title" className="max-w-[85%] break-words text-2xl font-black uppercase leading-[0.98] tracking-[-0.02em] text-white sm:text-3xl">
                  {title}
                </h2>
                <div className="mt-4 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  <CalendarDays size={12} style={{ color }} />
                  {announcement.date || 'Just now'}
                </div>
              </div>
            </header>

            <div className="p-6 sm:p-7">
              <div className="mb-5 flex items-center gap-3">
                <div className="h-px flex-1" style={{ background: `${color}48` }} />
                <span className="text-[8px] font-black uppercase tracking-[0.22em]" style={{ color: `${color}b8` }}>Intel</span>
                <div className="h-px w-10" style={{ background: `${color}48` }} />
              </div>
              <p id="announcement-detail-body" className="whitespace-pre-wrap break-words text-[13px] leading-[1.8] text-white/70 sm:text-sm">
                {body}
              </p>
              <div className="mt-7 flex items-center justify-between border-t pt-4" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                <span className="text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  BALOK bulletin
                </span>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
              </div>
            </div>
          </motion.article>
        </motion.div>
      )}
    </AnimatePresence>
  )
}