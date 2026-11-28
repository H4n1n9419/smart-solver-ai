import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt=promisify(crypto.scrypt);
const reply=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});

// --- Admin password tetap disimpan di Netlify Blobs (datanya cuma 1 kunci kecil,
// tidak ada hubungannya dengan jatah Blobs yang dulu habis karena 299rb soal) ---
async function verifyAdmin(store,k){
 const saved=await store.get("admin-password",{type:"json"});
 if(!saved)return !!process.env.KNOWLEDGE_ADMIN_KEY&&k===process.env.KNOWLEDGE_ADMIN_KEY;
 const d=await scrypt(k,Buffer.from(saved.salt,"hex"),64);
 return d.length===Buffer.from(saved.hash,"hex").length&&crypto.timingSafeEqual(d,Buffer.from(saved.hash,"hex"));
}

// --- Bank soal (jutaan baris) sekarang disimpan di Supabase Postgres, bukan Blobs.
// Postgres yang urus indeks pencarian & deduplikasi secara otomatis lewat kolom
// generated di tabel `questions` (lihat SQL di PETUNJUK_UPDATE.txt) ---
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,"");
const SB_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||"";
async function sb(path,{method="GET",body,headers={}}={}){
 if(!SB_URL||!SB_KEY)throw Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diatur di Environment Variables Netlify");
 const r=await fetch(`${SB_URL}/rest/v1/${path}`,{method,headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,"Content-Type":"application/json",...headers},body:body!==undefined?JSON.stringify(body):undefined});
 if(!r.ok){let msg=`Supabase ${r.status}`;try{const j=await r.json();msg=j.message||j.error_description||j.error||msg;}catch{}throw Error(msg);}
 if(r.status===204)return {data:null,headers:r.headers};
 return {data:await r.json(),headers:r.headers};
}
async function currentTotal(){
 const r=await fetch(`${SB_URL}/rest/v1/questions?select=id&limit=1`,{headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,Prefer:"count=exact"}});
 const range=r.headers.get("content-range")||"0/0";
 return Number(range.split("/")[1])||0;
}

async function callAI(provider,prompt){
 const signal=AbortSignal.timeout(22000);
 if(provider==="gemini"&&process.env.GEMINI_API_KEY){
  const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,maxOutputTokens:900}}),signal});
  const j=await r.json();if(!r.ok)throw Error(j.error?.message||`Gemini ${r.status}`);return j.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("\n").trim()||"";
 }
 let url,key,model,headers={};
 if(provider==="groq"){url="https://api.groq.com/openai/v1/chat/completions";key=process.env.GROQ_API_KEY;model=process.env.GROQ_MODEL||"llama-3.3-70b-versatile";}
 if(provider==="mistral"){url="https://api.mistral.ai/v1/chat/completions";key=process.env.MISTRAL_API_KEY;model=process.env.MISTRAL_MODEL||"mistral-small-latest";}
 if(provider==="openrouter"){url="https://openrouter.ai/api/v1/chat/completions";key=process.env.OPENROUTER_API_KEY;model=process.env.OPENROUTER_MODEL||"openrouter/auto";headers={"HTTP-Referer":process.env.SITE_URL||"https://smartsolverai.netlify.app","X-Title":"SMART AIRA AI"};}
 if(provider==="cloudflare"&&process.env.CF_ACCOUNT_ID&&process.env.CF_API_TOKEN){
  const m=process.env.CF_AI_MODEL||"@cf/meta/llama-3.1-8b-instruct";
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${m}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.CF_API_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"system",content:"Jawab Bahasa Indonesia, jelas, jangan mengarang."},{role:"user",content:prompt}]}),signal});
  const j=await r.json();if(!r.ok||j.success===false)throw Error(j.errors?.[0]?.message||`Cloudflare ${r.status}`);return j.result?.response||"";
 }
 if(!url||!key)throw Error(`${provider}: API key belum diatur`);
 const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`,...headers},body:JSON.stringify({model,messages:[{role:"system",content:"Kamu asisten SMART AIRA. Jawab Bahasa Indonesia, jelas, langsung, dan jangan mengarang fakta."},{role:"user",content:prompt}],temperature:.2,max_tokens:900}),signal});
 const j=await r.json();if(!r.ok)throw Error(j.error?.message||`${provider} ${r.status}`);return j.choices?.[0]?.message?.content?.trim()||"";
}

export default async function handler(req){
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  const body=await req.json(),action=body.action,store=getStore("smart-solver-questions"),admin=req.headers.get("x-admin-key")||"";
  const protectedActions=["admin-check","change-password","add","bulk-add","update","delete","export","wipe"];
  if(protectedActions.includes(action)&&!(await verifyAdmin(store,admin)))return reply({error:"Kunci admin tidak cocok"},401);
  if(action==="admin-check")return reply({ok:true});
  if(action==="change-password"){
   const p=String(body.newPassword||"");if(p.length<12||p===admin)return reply({error:"Kunci baru minimal 12 karakter dan harus berbeda"},400);
   const salt=crypto.randomBytes(16),hash=await scrypt(p,salt,64);await store.setJSON("admin-password",{salt:salt.toString("hex"),hash:hash.toString("hex"),updatedAt:new Date().toISOString()});return reply({ok:true});
  }

  if(action==="add"||action==="bulk-add"){
   const arr=action==="add"?[body]:body.items;if(!Array.isArray(arr)||!arr.length)return reply({error:"Data kosong atau format salah"},400);
   if(arr.length>100)return reply({error:"Maksimal 100 pasangan per batch"},413);
   let skipped=0;const payload=[];
   for(const item of arr){
    const question=String(item?.question??item?.soal??"").trim(),answer=String(item?.answer??item?.jawaban??"").trim();
    if(!question||!answer){skipped++;continue;}
    payload.push({question,answer});
   }
   if(!payload.length)return reply({ok:true,added:0,duplicates:0,skipped,total:await currentTotal()});
   // Upsert: baris yang norm_key-nya sudah ada (soal+jawaban identik) dilewati otomatis
   // oleh Postgres - tidak perlu lagi cek duplikat manual satu per satu.
   const {data:inserted}=await sb(`questions?on_conflict=norm_key`,{method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=representation"},body:payload});
   const added=(inserted||[]).length,duplicates=payload.length-added;
   return reply({ok:true,added,duplicates,skipped,total:await currentTotal()});
  }

  if(action==="search"){
   const query=String(body.query||"").trim();if(!query)return reply({results:[]});
   const {data:rows}=await sb(`questions?select=id,question,answer,updated_at&search_vec=plfts(simple).${encodeURIComponent(query)}&limit=20`);
   return reply({results:rows||[],searched:(rows||[]).length});
  }

  if(action==="list"){
   const limit=Math.min(Math.max(Number(body.limit)||100,1),100),offset=Math.max(Number(body.cursor)||0,0);
   const {data:rows}=await sb(`questions?select=id,question,answer,updated_at&order=created_at.desc&limit=${limit}&offset=${offset}`);
   const total=await currentTotal(),nextCursor=(rows&&rows.length===limit)?String(offset+limit):null;
   return reply({items:rows||[],total,nextCursor});
  }

  if(action==="export"){
   const all=[];let offset=0,loops=0;const page=500;
   while(true){
    const {data:rows}=await sb(`questions?select=id,question,answer,updated_at&order=created_at.asc&limit=${page}&offset=${offset}`);
    if(!rows||!rows.length)break;
    all.push(...rows);offset+=rows.length;loops++;
    if(rows.length<page)break;
    if(loops>1000)throw Error("Ekspor terlalu besar untuk sekali jalan - gunakan Table Editor Supabase untuk ekspor penuh.");
   }
   return reply({items:all,total:all.length});
  }

  if(action==="update"){
   const id=String(body.id||"");if(!id)return reply({error:"ID tidak valid"},400);
   const question=String(body.question||"").trim(),answer=String(body.answer||"").trim();if(!question||!answer)return reply({error:"Soal dan jawaban wajib diisi"},400);
   try{
    const {data:rows}=await sb(`questions?id=eq.${encodeURIComponent(id)}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:{question,answer,updated_at:new Date().toISOString()}});
    if(!rows||!rows.length)return reply({error:"Data tidak ditemukan"},404);
    return reply({ok:true,item:rows[0]});
   }catch(e){
    if(/duplicate key|unique constraint|norm_key/i.test(e.message))return reply({error:"Pasangan soal dan jawaban yang sama sudah ada"},409);
    throw e;
   }
  }

  if(action==="delete"){
   const id=String(body.id||"");if(!id)return reply({error:"ID tidak valid"},400);
   await sb(`questions?id=eq.${encodeURIComponent(id)}`,{method:"DELETE",headers:{Prefer:"return=minimal"}});
   return reply({ok:true});
  }

  if(action==="wipe"){
   if(String(body.confirm||"")!=="HAPUS SEMUA")return reply({error:"Konfirmasi tidak sesuai"},400);
   const before=await currentTotal();
   await sb(`questions?id=not.is.null`,{method:"DELETE",headers:{Prefer:"return=minimal"}});
   return reply({ok:true,deleted:before});
  }

  if(action==="vision"){
   const image=String(body.image||"");if(!image)return reply({error:"Gambar kosong"},400);
   const mime=String(body.mime||"image/jpeg");
   if(!process.env.GEMINI_API_KEY)return reply({error:"Fitur baca gambar perlu GEMINI_API_KEY diisi di Environment Variables Netlify."},503);
   try{
    const model=process.env.GEMINI_VISION_MODEL||process.env.GEMINI_MODEL||"gemini-2.0-flash";
    const prompt=`Ini screenshot soal ujian dari layar HP lain. Baca semua teks pada gambar dengan teliti. Bedakan mana kalimat SOAL (pertanyaan) dan mana PILIHAN JAWABAN bila ada (pilihan ganda atau esai). Tentukan jawaban yang paling tepat dan tulis penjelasan singkat kenapa itu jawabannya. Balas HANYA dalam format JSON persis seperti ini, tanpa teks lain: {"soal":"...","pilihan":["..."],"jawaban":"...","penjelasan":"..."}. Kosongkan array "pilihan" jika soal esai/tidak berpilihan ganda. Jika gambar tidak memuat soal yang bisa dibaca sama sekali, balas {"soal":null}.`;
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:image}}]}],generationConfig:{temperature:.1,maxOutputTokens:700,responseMimeType:"application/json"}}),signal:AbortSignal.timeout(25000)});
    const j=await r.json();if(!r.ok)throw Error(j.error?.message||`Gemini ${r.status}`);
    const text=j.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"{}";
    let parsed;try{parsed=JSON.parse(text);}catch{throw Error("Gagal membaca hasil AI (format tidak sesuai)");}
    if(!parsed||!parsed.soal)return reply({ok:true,soal:null});
    return reply({ok:true,soal:String(parsed.soal||"").trim(),pilihan:Array.isArray(parsed.pilihan)?parsed.pilihan.map(String):[],jawaban:String(parsed.jawaban||"").trim(),penjelasan:String(parsed.penjelasan||"").trim()});
   }catch(e){return reply({error:"Gagal membaca gambar: "+e.message},502);}
  }

  if(action==="ai"){
   const q=String(body.query||"").trim();if(!q)return reply({error:"Pertanyaan kosong"},400);
   const prompt=`Jawab pertanyaan berikut dalam Bahasa Indonesia. Ringkas, tepat, jangan menebak jika informasi kurang.\n\n${q}`;
   const failures=[];for(const p of ["gemini","groq","mistral","cloudflare","openrouter"]){try{const answer=await callAI(p,prompt);if(answer)return reply({ok:true,source:"ai",provider:p,answer});}catch(e){failures.push(`${p}: ${e.message}`);}}
   return reply({error:"Semua AI cadangan belum tersedia atau kuotanya habis.",details:failures},503);
  }

  return reply({error:"Aksi tidak dikenal"},400);
 }catch(e){console.error("knowledge:",e);return reply({error:e.message||"Server error"},500);}
}
