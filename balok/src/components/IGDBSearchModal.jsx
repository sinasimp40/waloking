import React, { useState } from 'react';
import { Search, X, Gamepad2, Loader2, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GhostBtn, PrimaryBtn, Input } from './AdminPanelShared';
import toast from 'react-hot-toast';
import useStore from '../store/useStore';

export default function IGDBSearchModal({ isOpen, onClose, onSelect }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const settings = useStore(s => s.settings);

  const handleSearch = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    try {
      let data = null;

      // Packaged desktop app: no HTTP server exists, go through Electron IPC.
      if (window.electronAPI?.igdbSearch) {
        data = await window.electronAPI.igdbSearch(
          query,
          settings.igdbClientId,
          settings.igdbClientSecret,
        );
      } else {
        // Browser/dev: try the dev-server middleware, then the app API route.
        const endpoints = ['/api/igdb/search', '/api/public/igdb/search'];
        for (const url of endpoints) {
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query,
                clientId: settings.igdbClientId,
                clientSecret: settings.igdbClientSecret,
              }),
            });
            if (!res.ok && res.status === 404) continue;
            data = await res.json();
            if (data?.results) break;
          } catch {
            /* try next endpoint */
          }
        }
      }

      if (data?.results?.length) setResults(data.results);
      else {
        setResults([]);
        toast.error(data?.error || 'No results found');
      }
    } catch (err) {
      toast.error(err?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-2xl bg-[#0A0A0B] border border-zinc-800 p-8 flex flex-col max-h-[80vh]"
          >
            <div className="flex items-center justify-between mb-8">
              <div className="flex flex-col">
                <h3 className="text-xl font-bold text-white uppercase tracking-widest font-jakarta">Import from IGDB</h3>
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">Global Gaming Database</span>
              </div>
              <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSearch} className="flex gap-4 mb-8">
              <div className="flex-1">
                <Input 
                  value={query} 
                  onChange={e => setQuery(e.target.value)} 
                  placeholder="Search for a game title..." 
                  className="!py-4"
                  autoFocus
                />
              </div>
              <PrimaryBtn type="submit" disabled={loading} className="min-w-[140px]">
                {loading ? <Loader2 size={18} className="animate-spin mx-auto" /> : 'Search'}
              </PrimaryBtn>
            </form>

            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-2">
              {results.length > 0 ? (
                results.map(game => (
                  <div 
                    key={game.id} 
                    className="group flex items-center gap-6 p-4 bg-zinc-950/50 border border-zinc-900 hover:border-zinc-700 transition-all cursor-pointer"
                    onClick={() => onSelect(game)}
                  >
                    <div className="w-16 h-20 bg-zinc-900 flex-shrink-0 overflow-hidden border border-zinc-800">
                      {game.icon ? (
                        <img src={game.icon} alt={game.name} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-800">
                          <Gamepad2 size={24} />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-bold text-white text-sm uppercase tracking-wide truncate">{game.name}</h4>
                      <p className="text-[10px] text-zinc-500 line-clamp-2 mt-1 leading-relaxed">{game.summary}</p>
                      {game.genres?.length > 0 && (
                        <div className="flex gap-2 mt-2">
                          {game.genres.slice(0, 3).map(g => (
                            <span key={g} className="text-[8px] font-bold text-zinc-700 uppercase tracking-widest border border-zinc-900 px-1.5 py-0.5">{g}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-8 h-8 flex items-center justify-center border border-zinc-800 text-zinc-500">
                        <Plus size={16} />
                      </div>
                    </div>
                  </div>
                ))
              ) : !loading && query && (
                <div className="text-center py-20 text-zinc-600 text-[10px] font-bold uppercase tracking-[0.2em]">
                  No results found for "{query}"
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
