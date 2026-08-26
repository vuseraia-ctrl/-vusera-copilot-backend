// ingest.js — Bir sənədi Vusera-nın "beyninə" yükləyir
//
// İstifadə: node ingest.js "Şirkət ID" "Sənəd adı" "Sənəd kodu" "fayl-yolu.txt" "rol1,rol2"
// Misal: node ingest.js "abc-123" "Leave Policy" "HR-002" "./docs/leave-policy.txt" ""
// (Son parametr — icazə tələb olunan rollar, boş buraxsanız hamıya açıq olur)

import 'dotenv/config';
import fs from 'fs';
import { supabase, getEmbedding, chunkDocument } from './lib.js';

async function ingestDocument(companyId, title, docCode, filePath, restrictedRolesStr) {
  console.log(`📄 Sənəd oxunur: ${filePath}`);
  const fullText = fs.readFileSync(filePath, 'utf-8');

  const restrictedRoles = restrictedRolesStr
    ? restrictedRolesStr.split(',').map(r => r.trim()).filter(Boolean)
    : [];

  // 1) Sənəd qeydini yarat
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .insert({
      company_id: companyId,
      title,
      doc_code: docCode,
      restricted_to_roles: restrictedRoles
    })
    .select()
    .single();

  if (docError) throw docError;
  console.log(`✅ Sənəd qeydə alındı: ${doc.id}`);

  // 2) Sənədi parçalara böl
  const chunks = chunkDocument(fullText);
  console.log(`✂️  ${chunks.length} parçaya bölündü`);

  // 3) Hər parça üçün embedding yarat və saxla
  for (const [i, chunk] of chunks.entries()) {
    const embedding = await getEmbedding(chunk.content);
    const { error: chunkError } = await supabase
      .from('document_chunks')
      .insert({
        document_id: doc.id,
        section_label: chunk.section_label,
        content: chunk.content,
        embedding
      });
    if (chunkError) throw chunkError;
    console.log(`  → Parça ${i + 1}/${chunks.length} yükləndi (${chunk.section_label || 'ümumi'})`);
  }

  console.log(`🎉 "${title}" tamamilə yükləndi və axtarışa hazırdır.`);
}

// Komanda sətirindən parametrləri oxu
const [,, companyId, title, docCode, filePath, restrictedRolesStr] = process.argv;

if (!companyId || !title || !filePath) {
  console.log('İstifadə: node ingest.js <companyId> <title> <docCode> <filePath> [restrictedRoles]');
  process.exit(1);
}

ingestDocument(companyId, title, docCode, filePath, restrictedRolesStr || '')
  .catch(err => { console.error('❌ Xəta:', err.message); process.exit(1); });
