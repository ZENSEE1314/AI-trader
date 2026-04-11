import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

type PetMood = 'IDLE' | 'WORKING' | 'BATTLE' | 'HAPPY';

export const PetOverlay: React.FC = () => {
  const [mood, setMood] = useState<PetMood>('IDLE');
  const [stats, setStats] = useState({ int: 10, atk: 10, prc: 10 });

  useEffect(() => {
    const timer = setInterval(() => {
      if (mood === 'IDLE') setMood('HAPPY');
      else if (mood === 'HAPPY') setMood('IDLE');
    }, 5000);
    return () => clearInterval(timer);
  }, [mood]);

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
      <motion.div
        drag
        className="pointer-events-auto cursor-grab active:cursor-grabbing relative group"
      >
        <div className="w-32 h-32 bg-indigo-500 rounded-full shadow-xl border-4 border-white flex items-center justify-center text-4xl relative overflow-hidden">
          <AnimatePresence mode="wait">
            {mood === 'IDLE' && (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>🤖</motion.div>
            )}
            {mood === 'WORKING' && (
              <motion.div key="work" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2 }}>⚙️</motion.div>
            )}
            {mood === 'BATTLE' && (
              <motion.div key="battle" animate={{ x: [-5, 5, -5] }} transition={{ repeat: Infinity, duration: 0.2 }}>🔥</motion.div>
            )}
            {mood === 'HAPPY' && (
              <motion.div key="happy" animate={{ y: [0, -10, 0] }} transition={{ repeat: Infinity, duration: 1 }}>✨</motion.div>
            )}
          </AnimatePresence>
          <div className="absolute -top-16 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 text-white text-xs p-2 rounded-lg whitespace-nowrap">
            INT: {stats.int} | ATK: {stats.atk} | PRC: {stats.prc}
          </div>
        </div>
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white bg-indigo-600 px-2 py-0.5 rounded-full uppercase tracking-widest">
          {mood}
        </div>
      </motion.div>
    </div>
  );
};
