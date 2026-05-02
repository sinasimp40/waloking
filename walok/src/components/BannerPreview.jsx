import React from 'react'
import FeaturedBanner from './FeaturedBanner'

export default function BannerPreview({ variant }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
      <FeaturedBanner bgVariant={variant} />
      <div className="px-4 py-2 text-[10px] font-orbitron tracking-widest text-white/30 uppercase">
        Banner background variant: {variant}
      </div>
    </div>
  )
}
