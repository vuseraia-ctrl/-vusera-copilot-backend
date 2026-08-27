// lib.js — Voyage AI embeddings + Supabase client helper-ləri

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Bu, istifadəçi girişini (login) yoxlamaq üçün ayrıca "public" açarla yaradılan clientdir.
// Admin client (yuxarıdakı) hər şeyə giriş edə bilir, amma login/parol yoxlaması üçün
// düzgün üsul, adi (anon) açarla işləyən bir client istifadə etməkdir.
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Bir mətn parçasının embedding-ini (rəqəmsal "mənasını") Voyage AI ilə alır.
// Bu, axtarış üçün lazımdır: oxşar mənalı mətnlər, oxşar embedding-lərə malik olur.
export async function getEmbedding(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: text,
      model: 'voyage-2'
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Voyage AI xətası: ${errText}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

// Uzun bir sənədi kiçik "chunk"lara (parçalara) bölür.
// Hər chunk təxminən 500-700 simvol olur, bölmə (section) başlıqlarına görə bölünür.
export function chunkDocument(fullText) {
  // "Section X.X" ilə başlayan sətirlərə görə bölürük
  const sections = fullText.split(/(?=Section \d+\.\d+)/g);
  const chunks = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const labelMatch = trimmed.match(/Section (\d+\.\d+)/);
    chunks.push({
      section_label: labelMatch ? `Section ${labelMatch[1]}` : null,
      content: trimmed
    });
  }
  return chunks.length > 0 ? chunks : [{ section_label: null, content: fullText.trim() }];
}
