import { useState, useEffect } from "react";

// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://SEU_PROJETO.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "SUA_CHAVE_ANON_AQUI";

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`Supabase ${res.status}: ${e}`); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}
const db = {
  select: (table, params = "") => sbFetch(`${table}?${params}`),
  insert: (table, body) => sbFetch(table, { method: "POST", body: JSON.stringify(body) }),
  update: (table, filter, body) => sbFetch(`${table}?${filter}`, { method: "PATCH", body: JSON.stringify(body) }),
  upsert: (table, body) => sbFetch(table, { method: "POST", body: JSON.stringify(body), headers: { Prefer: "resolution=merge-duplicates,return=representation" } }),
};

// ============================================================
// CÁLCULO DE HORAS — lógica completa com expediente multi-dia
// ============================================================
// Expediente: Seg-Qui 07:00–12:00 e 13:00–17:30 | Sex 07:00–12:30
// Pintura não desconta almoço e não filtra expediente da mesma forma
// Retorna horas produtivas dentro do expediente + horas_extras informadas

const EXPEDIENTE = {
  // dia da semana (0=Dom...6=Sáb): [[inicioMin, fimMin], ...janelas]
  1: [[7*60, 12*60], [13*60, 17*60+30]], // Seg
  2: [[7*60, 12*60], [13*60, 17*60+30]], // Ter
  3: [[7*60, 12*60], [13*60, 17*60+30]], // Qua
  4: [[7*60, 12*60], [13*60, 17*60+30]], // Qui
  5: [[7*60, 12*60+30]],                  // Sex
};

function minutosExpedienteNoDia(dow, aMin, bMin) {
  // Minutos de expediente entre aMin e bMin (minutos desde meia-noite) no dia da semana dow
  const janelas = EXPEDIENTE[dow] || [];
  let total = 0;
  for (const [j0, j1] of janelas) {
    const s = Math.max(aMin, j0);
    const e = Math.min(bMin, j1);
    if (e > s) total += e - s;
  }
  return total;
}

function calcHorasExpediente(dtInicioStr, horaInicioStr, dtTerminoStr, horaTerminoStr) {
  // dtStr = "YYYY-MM-DD", horaStr = "HH:MM"
  if (!dtInicioStr || !horaInicioStr || !dtTerminoStr || !horaTerminoStr) return 0;
  const [yi, mi, di] = dtInicioStr.split("-").map(Number);
  const [yt, mt, dt] = dtTerminoStr.split("-").map(Number);
  const [hi, mni] = horaInicioStr.split(":").map(Number);
  const [ht, mnt] = horaTerminoStr.split(":").map(Number);

  const inicio  = new Date(yi, mi-1, di, hi, mni, 0);
  const termino = new Date(yt, mt-1, dt, ht, mnt, 0);
  if (termino <= inicio) return 0;

  let totalMin = 0;
  const cur = new Date(inicio);

  while (cur < termino) {
    const nextMidnight = new Date(cur);
    nextMidnight.setHours(24, 0, 0, 0);
    const dayEnd = nextMidnight < termino ? nextMidnight : termino;

    const dow = cur.getDay();
    const aMin = cur.getHours() * 60 + cur.getMinutes();
    const bMin = dayEnd.getHours() * 60 + dayEnd.getMinutes() || 24 * 60;
    totalMin += minutosExpedienteNoDia(dow, aMin, bMin === 0 ? 24*60 : bMin);

    cur.setTime(nextMidnight.getTime());
  }
  return totalMin / 60;
}

function calcHorasPintura(dtInicioStr, horaInicioStr, dtTerminoStr, horaTerminoStr) {
  // Pintura: sem desconto de almoço, mas ainda calcula dias corretamente
  if (!dtInicioStr || !horaInicioStr || !dtTerminoStr || !horaTerminoStr) return 0;
  const [yi, mi, di] = dtInicioStr.split("-").map(Number);
  const [yt, mt, dt] = dtTerminoStr.split("-").map(Number);
  const [hi, mni] = horaInicioStr.split(":").map(Number);
  const [ht, mnt] = horaTerminoStr.split(":").map(Number);
  const inicio  = new Date(yi, mi-1, di, hi, mni);
  const termino = new Date(yt, mt-1, dt, ht, mnt);
  return Math.max(0, (termino - inicio) / 3600000);
}

function calcHorasFinal(dtInicio, hInicio, dtTermino, hTermino, horasExtras, ehPintura) {
  const base = ehPintura
    ? calcHorasPintura(dtInicio, hInicio, dtTermino, hTermino)
    : calcHorasExpediente(dtInicio, hInicio, dtTermino, hTermino);
  return Math.max(0, base + (parseFloat(horasExtras) || 0));
}

function previewHoras(dtInicio, hInicio, dtTermino, hTermino, horasExtras, ehPintura) {
  if (!dtInicio || !hInicio || !dtTermino || !hTermino) return null;
  return calcHorasFinal(dtInicio, hInicio, dtTermino, hTermino, horasExtras, ehPintura);
}

// ============================================================
// UTILITÁRIOS
// ============================================================
function fmt(n) { return n < 10 ? "0" + n : n; }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${fmt(d.getMonth()+1)}-${fmt(d.getDate())}`;
}
function nowTimeStr() {
  const d = new Date();
  return `${fmt(d.getHours())}:${fmt(d.getMinutes())}`;
}
function exportToCSV(data, filename) {
  const csv = data.map(r => r.map(c => (typeof c === "string" && c.includes(",")) ? `"${c}"` : (c ?? "")).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ============================================================
// DADOS INICIAIS
// ============================================================
const INITIAL_CADASTROS = {
  operadores: [
    { id: 1, nome: "Neri", setor: "Corte", status: "Ativo" },
    { id: 2, nome: "Aroeira", setor: "Corte", status: "Ativo" },
    { id: 3, nome: "André", setor: "Corte", status: "Ativo" },
    { id: 4, nome: "Neri", setor: "Solda", status: "Ativo" },
    { id: 5, nome: "Aroeira", setor: "Solda", status: "Ativo" },
    { id: 6, nome: "André", setor: "Solda", status: "Ativo" },
    { id: 7, nome: "Rafael", setor: "Projeto", status: "Ativo" },
    { id: 8, nome: "Jonathan", setor: "Projeto", status: "Ativo" },
    { id: 9, nome: "Sidney", setor: "Projeto", status: "Ativo" },
    { id: 10, nome: "Wellington", setor: "Projeto", status: "Ativo" }
  ],
  equipamentos: [
    { id: 1, nome: "-", setor: "Corte", status: "Ativo" },
    { id: 2, nome: "Dobradeira", setor: "Corte", status: "Ativo" },
    { id: 3, nome: "Corte à Laser", setor: "Corte", status: "Ativo" }
  ],
  cores: [
    { id: 1, nome: "Branco", custo_kg: 25.00, status: "Ativo" },
    { id: 2, nome: "Preto", custo_kg: 28.00, status: "Ativo" },
    { id: 3, nome: "Cinza", custo_kg: 26.50, status: "Ativo" }
  ],
  fornos: [
    { id: 1, nome: "Forno 1", status: "Ativo" },
    { id: 2, nome: "Forno 2", status: "Ativo" }
  ],
  tipos: [
    { id: 1, nome: "Projeto", status: "Ativo" },
    { id: 2, nome: "Alteração Projeto", status: "Ativo" },
    { id: 3, nome: "Detalhamento", status: "Ativo" },
    { id: 4, nome: "Alteração Detalhamento", status: "Ativo" },
    { id: 5, nome: "Documentação", status: "Ativo" },
    { id: 6, nome: "Teste", status: "Ativo" }
  ]
};

// ============================================================
// ESTILOS
// ============================================================
const S = {
  inp: { width:"100%", border:"1px solid #4a4a4a", borderRadius:8, padding:"10px 12px", fontSize:13, outline:"none", background:"#2a2a2a", color:"#fff", boxSizing:"border-box" },
  btn: { background:"#E57B25", border:"none", borderRadius:8, padding:"10px 20px", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnSec: { background:"#154766", border:"none", borderRadius:8, padding:"10px 20px", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnDanger: { background:"#ef4444", border:"none", borderRadius:8, padding:"10px 20px", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnGreen: { background:"#10b981", border:"none", borderRadius:8, padding:"10px 20px", color:"#fff", fontWeight:700, fontSize:13, cursor:"pointer" },
  label: { fontSize:12, fontWeight:600, color:"#9ca3af", display:"block", marginBottom:6 },
  card: { background:"#1f1f1f", borderRadius:12, padding:24, border:"1px solid #3a3a3a" },
};
const SBG   = { Projeto:"#154766", Corte:"#4a3000", Solda:"#4a1a3a", Pintura:"#1a4a2a" };
const STXT  = { Projeto:"#7dd3fc", Corte:"#fbbf24", Solda:"#f472b6", Pintura:"#6ee7b7" };

const Field = ({ label, children }) => (
  <div>
    <span style={S.label}>{label}</span>
    {children}
  </div>
);

const HintAndamento = () => (
  <p style={{ fontSize:11, color:"#6b7280", marginTop:5, marginBottom:0 }}>
    Deixe vazio para registrar como "Em Andamento"
  </p>
);

const ExpedienteNote = () => (
  <span style={{ color:"#6b7280", fontSize:11, marginLeft:8 }}>
    (seg–qui 07–17:30 · sex 07–12:30 · desconta almoço 12–13)
  </span>
);

// ============================================================
// FORM ITEMS (Solda/Pintura multi-SKU com OP por item)
// ============================================================
function ItemRows({ itens, onChange, onAdd, onRemove, maxItems = 5, placeholder = "SKU" }) {
  return (
    <div>
      {itens.map((item, i) => (
        <div key={i} style={{ display:"grid", gridTemplateColumns:"110px 1fr 90px 90px 36px", gap:8, marginBottom:8, alignItems:"center" }}>
          <input placeholder={placeholder} style={S.inp} value={item.sku}
            onChange={e => onChange(i, "sku", e.target.value)} />
          <input placeholder="Descrição" style={S.inp} value={item.descricao}
            onChange={e => onChange(i, "descricao", e.target.value)} />
          <input placeholder="Qtd" type="number" style={S.inp} value={item.quantidade}
            onChange={e => onChange(i, "quantidade", e.target.value)} />
          <input placeholder="OP" style={S.inp} value={item.op || ""}
            onChange={e => onChange(i, "op", e.target.value)} />
          {itens.length > 1
            ? <button onClick={() => onRemove(i)} style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444", fontSize:16 }}>🗑️</button>
            : <span />
          }
        </div>
      ))}
      {itens.length < maxItems && (
        <button onClick={onAdd} style={{ fontSize:12, color:"#E57B25", background:"none", border:"none", cursor:"pointer", fontWeight:600, marginTop:4 }}>
          + Adicionar SKU
        </button>
      )}
    </div>
  );
}

// ============================================================
// APP
// ============================================================
export default function App() {
  const [tab, setTab]             = useState("novo");
  const [setor, setSetor]         = useState("Projeto");
  const [cadastros, setCadastros] = useState(INITIAL_CADASTROS);
  const [saved, setSaved]         = useState(false);
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);
  const [dbError, setDbError]     = useState(false);

  // Modals
  const [confirmModal,   setConfirmModal]   = useState(null);
  const [finalizarModal, setFinalizarModal] = useState(null);
  const [editRecModal,   setEditRecModal]   = useState(null); // editar registro
  const [inativarModal,  setInativarModal]  = useState(null); // inativar registro
  const [editModal,      setEditModal]      = useState(null); // editar cadastro
  const [deleteConfirm,  setDeleteConfirm]  = useState(null);

  // Dados
  const [projeto,      setProjeto]      = useState([]);
  const [corte,        setCorte]        = useState([]);
  const [corteItens,   setCorteItens]   = useState([]);
  const [solda,        setSolda]        = useState([]);
  const [pintura,      setPintura]      = useState([]);
  const [pinturaItens, setPinturaItens] = useState([]);

  // Filtros registros
  const [filterSku,      setFilterSku]      = useState("");
  const [filterOperador, setFilterOperador] = useState("");
  const [filterSetor,    setFilterSetor]    = useState("");
  const [filterEquip,    setFilterEquip]    = useState("");

  // Dashboard
  const [searchSku,     setSearchSku]     = useState("");
  const [dashFilterSetor, setDashFilterSetor] = useState("");
  const [dashFilterOp,    setDashFilterOp]    = useState("");

  // ---- Forms ----
  const emptyItem = (extra = {}) => ({ sku:"", descricao:"", quantidade:"", op:"", ...extra });

  const emptyProjeto = () => ({
    data: todayStr(), data_termino: todayStr(),
    operador:"", tipo:"", sku:"", op:"", descricao:"",
    hora_inicio:"", hora_termino:"", horas_extras:"0"
  });
  const emptyCorte = () => ({
    data: todayStr(), data_termino: todayStr(),
    operador:"", equipamento:"", op:"",
    hora_inicio:"", hora_termino:"", horas_extras:"0",
    itens:[emptyItem()]
  });
  const emptySolda = () => ({
    data: todayStr(), data_termino: todayStr(),
    operador:"", hora_inicio:"", hora_termino:"", horas_extras:"0",
    itens:[emptyItem({ quantidade:"" })]
  });
  const emptyPintura = () => ({
    data: todayStr(), data_termino: todayStr(),
    forno:"", cor:"", kgs_tinta:"",
    hora_inicio:"", hora_termino:"", horas_extras:"0",
    itens:[emptyItem({ quantidade:"" })]
  });

  const [formProjeto, setFormProjeto] = useState(emptyProjeto());
  const [formCorte,   setFormCorte]   = useState(emptyCorte());
  const [formSolda,   setFormSolda]   = useState(emptySolda());
  const [formPintura, setFormPintura] = useState(emptyPintura());

  const [novoCadastro, setNovoCadastro] = useState({
    operador:    { nome:"", setor:"Corte" },
    equipamento: { nome:"", setor:"Corte" },
    cor:         { nome:"", custo_kg:"" },
    forno:       { nome:"" },
    tipo:        { nome:"" }
  });

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const tryGet = async (table, params) => { try { return await db.select(table, params); } catch { return []; } };
      const [cad, proj, cort, cortIt, sold, pint, pintIt] = await Promise.all([
        tryGet("cadastros","select=*"),
        tryGet("apontamentos_projeto","select=*&order=created_at.desc"),
        tryGet("apontamentos_corte","select=*&order=created_at.desc"),
        tryGet("apontamentos_corte_itens","select=*"),
        tryGet("apontamentos_solda","select=*&order=created_at.desc"),
        tryGet("apontamentos_pintura","select=*&order=created_at.desc"),
        tryGet("apontamentos_pintura_itens","select=*"),
      ]);
      if (cad && cad.length > 0) {
        const obj = {};
        cad.forEach(r => { obj[r.chave] = JSON.parse(r.valor); });
        if (obj.operadores) setCadastros(obj);
      }
      setProjeto(proj||[]); setCorte(cort||[]); setCorteItens(cortIt||[]);
      setSolda(sold||[]); setPintura(pint||[]); setPinturaItens(pintIt||[]);
      setDbError(false);
    } catch(e) {
      setDbError(true);
      try {
        const c = localStorage.getItem("ap-cad"); if (c) setCadastros(JSON.parse(c));
        [["projeto",setProjeto],["corte",setCorte],["corte_itens",setCorteItens],
         ["solda",setSolda],["pintura",setPintura],["pintura_itens",setPinturaItens]].forEach(([k,fn]) => {
          const v = localStorage.getItem(`ap-${k}`); if (v) fn(JSON.parse(v));
        });
      } catch {}
    }
    setLoading(false);
  }

  async function persistCadastros(novos) {
    setCadastros(novos);
    try {
      for (const [chave, valor] of Object.entries(novos))
        await db.upsert("cadastros", { chave, valor: JSON.stringify(valor) });
    } catch { localStorage.setItem("ap-cad", JSON.stringify(novos)); }
  }

  function showSaved() { setSaved(true); setTimeout(() => setSaved(false), 2500); }

  // ============================================================
  // HELPERS
  // ============================================================
  function mkSolda(form) {
    const dtI = form.data, hI = form.hora_inicio;
    const dtT = form.data_termino || form.data, hT = form.hora_termino;
    const horas = hT ? calcHorasFinal(dtI, hI, dtT, hT, form.horas_extras, false) : null;
    return {
      data: dtI, data_termino: hT ? dtT : null,
      operador: form.operador,
      hora_inicio: hI, hora_termino: hT || null,
      horas_total: horas, horas_extras: parseFloat(form.horas_extras)||0,
      em_andamento: !hT, status:"Ativo",
      _itens: form.itens,
    };
  }
  function mkPintura(form) {
    const dtI = form.data, hI = form.hora_inicio;
    const dtT = form.data_termino || form.data, hT = form.hora_termino;
    const horas = hT ? calcHorasFinal(dtI, hI, dtT, hT, form.horas_extras, true) : null;
    return {
      data: dtI, data_termino: hT ? dtT : null,
      forno: form.forno, cor: form.cor, kgs_tinta: parseFloat(form.kgs_tinta)||0,
      hora_inicio: hI, hora_termino: hT || null,
      horas_total: horas, horas_extras: parseFloat(form.horas_extras)||0,
      em_andamento: !hT, status:"Ativo",
      _itens: form.itens,
    };
  }

  // ============================================================
  // CONFIRMS ABRIR
  // ============================================================
  function openConfirmProjeto() {
    const f = formProjeto;
    if (!f.operador||!f.tipo||!f.sku||!f.hora_inicio) return alert("Preencha: Operador, Tipo, SKU e Hora Início.");
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const h = f.hora_termino ? calcHorasFinal(f.data, f.hora_inicio, dtT, f.hora_termino, f.horas_extras, false) : null;
    setConfirmModal({
      tipo:"projeto", emAndamento:!f.hora_termino,
      data:{ Data:f.data, Operador:f.operador, Tipo:f.tipo, SKU:f.sku, OP:f.op||"-",
             Descrição:f.descricao||"-",
             "Data/Hora Início":`${f.data} ${f.hora_inicio}`,
             "Data/Hora Término":f.hora_termino ? `${dtT} ${f.hora_termino}` : "⏳ Em andamento",
             "Horas Extras":f.horas_extras||"0",
             ...(h!=null?{"Horas Total":h.toFixed(2)+"h"}:{}) }
    });
  }
  function openConfirmCorte() {
    const f = formCorte;
    if (!f.operador||!f.hora_inicio||!f.itens[0].sku) return alert("Preencha: Operador, Hora Início e ao menos um SKU.");
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const h = f.hora_termino ? calcHorasFinal(f.data, f.hora_inicio, dtT, f.hora_termino, f.horas_extras, false) : null;
    const itens = f.itens.filter(i=>i.sku);
    setConfirmModal({
      tipo:"corte", emAndamento:!f.hora_termino,
      data:{ Data:f.data, Operador:f.operador, Equipamento:f.equipamento||"-", OP:f.op||"-",
             "Data/Hora Início":`${f.data} ${f.hora_inicio}`,
             "Data/Hora Término":f.hora_termino ? `${dtT} ${f.hora_termino}` : "⏳ Em andamento",
             "Horas Extras":f.horas_extras||"0",
             ...(h!=null?{"Horas Total":h.toFixed(2)+"h","SKUs":itens.length}:{"SKUs":itens.length}) },
      itens,
    });
  }
  function openConfirmSolda() {
    const f = formSolda;
    if (!f.operador||!f.itens[0].sku||!f.hora_inicio) return alert("Preencha: Operador, ao menos um SKU e Hora Início.");
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const h = f.hora_termino ? calcHorasFinal(f.data, f.hora_inicio, dtT, f.hora_termino, f.horas_extras, false) : null;
    const itens = f.itens.filter(i=>i.sku);
    setConfirmModal({
      tipo:"solda", emAndamento:!f.hora_termino,
      data:{ Data:f.data, Operador:f.operador,
             "Data/Hora Início":`${f.data} ${f.hora_inicio}`,
             "Data/Hora Término":f.hora_termino ? `${dtT} ${f.hora_termino}` : "⏳ Em andamento",
             "Horas Extras":f.horas_extras||"0",
             ...(h!=null?{"Horas Total":h.toFixed(2)+"h","SKUs":itens.length}:{"SKUs":itens.length}) },
      itens,
    });
  }
  function openConfirmPintura() {
    const f = formPintura;
    if (!f.forno||!f.cor||!f.hora_inicio||!f.itens[0].sku) return alert("Preencha: Forno, Cor, Hora Início e ao menos um SKU.");
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const h = f.hora_termino ? calcHorasFinal(f.data, f.hora_inicio, dtT, f.hora_termino, f.horas_extras, true) : null;
    const itens = f.itens.filter(i=>i.sku);
    setConfirmModal({
      tipo:"pintura", emAndamento:!f.hora_termino,
      data:{ Data:f.data, Forno:f.forno, Cor:f.cor, "Kgs Tinta":f.kgs_tinta||"-",
             "Data/Hora Início":`${f.data} ${f.hora_inicio}`,
             "Data/Hora Término":f.hora_termino ? `${dtT} ${f.hora_termino}` : "⏳ Em andamento",
             "Horas Extras":f.horas_extras||"0",
             ...(h!=null?{"Horas Total":h.toFixed(2)+"h","SKUs":itens.length}:{"SKUs":itens.length}) },
      itens,
    });
  }

  async function confirmarSalvar() {
    setSyncing(true);
    if (confirmModal.tipo==="projeto") await submitProjeto();
    else if (confirmModal.tipo==="corte") await submitCorte();
    else if (confirmModal.tipo==="solda") await submitSolda();
    else if (confirmModal.tipo==="pintura") await submitPintura();
    setConfirmModal(null); setSyncing(false);
  }

  // ============================================================
  // SUBMITS
  // ============================================================
  async function submitProjeto() {
    const f = formProjeto;
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const horas = f.hora_termino ? calcHorasFinal(f.data,f.hora_inicio,dtT,f.hora_termino,f.horas_extras,false) : null;
    const novo = { data:f.data, data_termino:dtT, operador:f.operador, tipo:f.tipo, sku:f.sku, op:f.op,
      descricao:f.descricao, hora_inicio:f.hora_inicio, hora_termino:f.hora_termino||null,
      horas_total:horas, horas_extras:parseFloat(f.horas_extras)||0, em_andamento:!f.hora_termino, status:"Ativo" };
    try { const [r] = await db.insert("apontamentos_projeto", novo); setProjeto(p=>[r,...p]); }
    catch { setProjeto(p=>[{id:Date.now(),...novo},...p]); }
    setFormProjeto(emptyProjeto()); showSaved();
  }

  async function submitCorte() {
    const f = formCorte;
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const horas = f.hora_termino ? calcHorasFinal(f.data,f.hora_inicio,dtT,f.hora_termino,f.horas_extras,false) : null;
    const base = { data:f.data, data_termino:dtT, operador:f.operador, equipamento:f.equipamento, op:f.op,
      hora_inicio:f.hora_inicio, hora_termino:f.hora_termino||null,
      horas_total:horas, horas_extras:parseFloat(f.horas_extras)||0, em_andamento:!f.hora_termino, status:"Ativo" };
    try {
      const [savedC] = await db.insert("apontamentos_corte", base);
      setCorte(p=>[{...savedC,_itens:f.itens},...p]);
      if (!base.em_andamento) await explodirCorteItens(savedC.id, horas, f.itens);
    } catch {
      setCorte(p=>[{id:Date.now(),...base,_itens:f.itens},...p]);
    }
    setFormCorte(emptyCorte()); showSaved();
  }

  async function submitSolda() {
    const f = formSolda;
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const horas = f.hora_termino ? calcHorasFinal(f.data,f.hora_inicio,dtT,f.hora_termino,f.horas_extras,false) : null;
    const base = { data:f.data, data_termino:dtT, operador:f.operador,
      hora_inicio:f.hora_inicio, hora_termino:f.hora_termino||null,
      horas_total:horas, horas_extras:parseFloat(f.horas_extras)||0, em_andamento:!f.hora_termino, status:"Ativo" };
    try {
      const [savedS] = await db.insert("apontamentos_solda", base);
      setSolda(p=>[{...savedS,_itens:f.itens},...p]);
      if (!base.em_andamento) await explodirSoldaItens(savedS.id, horas, f.itens);
    } catch {
      setSolda(p=>[{id:Date.now(),...base,_itens:f.itens},...p]);
    }
    setFormSolda(emptySolda()); showSaved();
  }

  async function submitPintura() {
    const f = formPintura;
    const dtT = f.hora_termino ? (f.data_termino||f.data) : null;
    const horas = f.hora_termino ? calcHorasFinal(f.data,f.hora_inicio,dtT,f.hora_termino,f.horas_extras,true) : null;
    const kg = parseFloat(f.kgs_tinta)||0;
    const base = { data:f.data, data_termino:dtT, forno:f.forno, cor:f.cor, kgs_tinta:kg,
      hora_inicio:f.hora_inicio, hora_termino:f.hora_termino||null,
      horas_total:horas, horas_extras:parseFloat(f.horas_extras)||0, em_andamento:!f.hora_termino, status:"Ativo" };
    try {
      const [savedP] = await db.insert("apontamentos_pintura", base);
      const id = savedP.id_fornada||savedP.id;
      setPintura(p=>[{...savedP,_itens:f.itens},...p]);
      if (!base.em_andamento) await explodirPinturaItens(id, horas, kg, f.itens);
    } catch {
      setPintura(p=>[{id_fornada:Date.now(),...base,_itens:f.itens},...p]);
    }
    setFormPintura(emptyPintura()); showSaved();
  }

  // ============================================================
  // EXPLODIR ITENS
  // ============================================================
  async function explodirCorteItens(id, horas, itens) {
    const totalQtd = itens.reduce((a,i)=>a+(parseFloat(i.quantidade)||0),0);
    const data = itens.filter(i=>i.sku).map(item=>({
      id_apontamento:id, sku:item.sku, descricao:item.descricao,
      quantidade:parseFloat(item.quantidade)||0,
      horas_rateadas:totalQtd>0?(horas*(parseFloat(item.quantidade)||0)/totalQtd):0,
      status:"Ativo",
    }));
    if (data.length>0) { const r=await db.insert("apontamentos_corte_itens",data); setCorteItens(p=>[...r,...p]); }
  }
  async function explodirSoldaItens(id, horas, itens) {
    const totalQtd = itens.reduce((a,i)=>a+(parseFloat(i.quantidade)||0),0);
    const data = itens.filter(i=>i.sku).map(item=>({
      id_apontamento_solda:id, sku:item.sku, descricao:item.descricao, op:item.op||null,
      quantidade:parseFloat(item.quantidade)||0,
      horas_rateadas:totalQtd>0?(horas*(parseFloat(item.quantidade)||0)/totalQtd):0,
      status:"Ativo",
    }));
    if (data.length>0) { const r=await db.insert("apontamentos_solda_itens",data); setSoldaItens(p=>[...r,...p]); }
  }
  async function explodirPinturaItens(id, horas, kg, itens) {
    const totalQtd = itens.reduce((a,i)=>a+(parseFloat(i.quantidade)||0),0);
    const data = itens.filter(i=>i.sku).map(item=>{
      const q=parseFloat(item.quantidade)||0;
      return { id_fornada:id, sku:item.sku, descricao:item.descricao, op:item.op||null,
        quantidade:q, horas_rateadas:totalQtd>0?(horas*q/totalQtd):0,
        kgs_rateados:totalQtd>0?(kg*q/totalQtd):0, status:"Ativo" };
    });
    if (data.length>0) { const r=await db.insert("apontamentos_pintura_itens",data); setPinturaItens(p=>[...r,...p]); }
  }

  // ============================================================
  // SOLDA ITENS STATE (nova tabela)
  // ============================================================
  const [soldaItens, setSoldaItens] = useState([]);
  // Carregado junto no loadAll — ajustar loadAll abaixo:
  useEffect(() => {
    async function loadSoldaItens() {
      try { const r = await db.select("apontamentos_solda_itens","select=*"); setSoldaItens(r||[]); } catch {}
    }
    loadSoldaItens();
  }, []);

  // ============================================================
  // FINALIZAR EM ANDAMENTO
  // ============================================================
  function abrirFinalizar(tipo, reg) {
    setFinalizarModal({ tipo, registro:reg, data_termino:todayStr(), hora_termino:nowTimeStr(), horas_extras:"0" });
  }

  async function confirmarFinalizar() {
    const { tipo, registro, data_termino, hora_termino, horas_extras } = finalizarModal;
    if (!hora_termino) return alert("Informe a hora de término.");
    setSyncing(true);
    const ehPintura = tipo==="pintura";
    const horas = calcHorasFinal(registro.data, registro.hora_inicio, data_termino, hora_termino, horas_extras, ehPintura);
    const upd = { data_termino, hora_termino, horas_total:horas, horas_extras:parseFloat(horas_extras)||0, em_andamento:false };

    try {
      if (tipo==="projeto") {
        await db.update("apontamentos_projeto",`id=eq.${registro.id}`,upd);
        setProjeto(p=>p.map(x=>x.id===registro.id?{...x,...upd}:x));
      } else if (tipo==="corte") {
        await db.update("apontamentos_corte",`id=eq.${registro.id}`,upd);
        setCorte(p=>p.map(x=>x.id===registro.id?{...x,...upd}:x));
        const itens = registro._itens||[];
        if (itens.length>0) await explodirCorteItens(registro.id, horas, itens);
      } else if (tipo==="solda") {
        await db.update("apontamentos_solda",`id=eq.${registro.id}`,upd);
        setSolda(p=>p.map(x=>x.id===registro.id?{...x,...upd}:x));
        const itens = registro._itens||[];
        if (itens.length>0) await explodirSoldaItens(registro.id, horas, itens);
      } else if (tipo==="pintura") {
        const id = registro.id_fornada||registro.id;
        await db.update("apontamentos_pintura",`id_fornada=eq.${id}`,upd);
        setPintura(p=>p.map(x=>(x.id_fornada||x.id)===id?{...x,...upd}:x));
        const itens = registro._itens||[];
        const kg = registro.kgs_tinta||0;
        if (itens.length>0) await explodirPinturaItens(id, horas, kg, itens);
      }
    } catch(e) { console.error(e); alert("Erro ao finalizar: "+e.message); }
    setFinalizarModal(null); setSyncing(false); showSaved();
  }

  // ============================================================
  // EDITAR / INATIVAR REGISTRO
  // ============================================================
  async function salvarEdicaoRegistro() {
    const { tipo, id, campos } = editRecModal;
    const tbl = { projeto:"apontamentos_projeto", corte:"apontamentos_corte",
                  solda:"apontamentos_solda", pintura:"apontamentos_pintura" }[tipo];
    const filtro = tipo==="pintura"?`id_fornada=eq.${id}`:`id=eq.${id}`;
    try { await db.update(tbl, filtro, campos); } catch {}
    if (tipo==="projeto") setProjeto(p=>p.map(x=>x.id===id?{...x,...campos}:x));
    else if (tipo==="corte") setCorte(p=>p.map(x=>x.id===id?{...x,...campos}:x));
    else if (tipo==="solda") setSolda(p=>p.map(x=>x.id===id?{...x,...campos}:x));
    else if (tipo==="pintura") setPintura(p=>p.map(x=>(x.id_fornada||x.id)===id?{...x,...campos}:x));
    setEditRecModal(null); showSaved();
  }

  async function confirmarInativar() {
    const { tipo, id } = inativarModal;
    const upd = { status:"Inativo" };
    const tbl = { projeto:"apontamentos_projeto", corte:"apontamentos_corte",
                  solda:"apontamentos_solda", pintura:"apontamentos_pintura" }[tipo];
    const filtro = tipo==="pintura"?`id_fornada=eq.${id}`:`id=eq.${id}`;
    try { await db.update(tbl, filtro, upd); } catch {}
    if (tipo==="projeto") setProjeto(p=>p.map(x=>x.id===id?{...x,...upd}:x));
    else if (tipo==="corte") setCorte(p=>p.map(x=>x.id===id?{...x,...upd}:x));
    else if (tipo==="solda") setSolda(p=>p.map(x=>x.id===id?{...x,...upd}:x));
    else if (tipo==="pintura") setPintura(p=>p.map(x=>(x.id_fornada||x.id)===id?{...x,...upd}:x));
    setInativarModal(null); showSaved();
  }

  // ============================================================
  // CADASTROS
  // ============================================================
  async function saveCadastroEdit() {
    const { tipo, item } = editModal;
    const novos = { ...cadastros };
    const idx = novos[tipo].findIndex(i=>i.id===item.id);
    if (idx>=0) novos[tipo][idx] = item;
    await persistCadastros(novos);
    setEditModal(null); showSaved();
  }
  async function deleteCadastro(tipo, id) {
    const novos = { ...cadastros };
    novos[tipo] = novos[tipo].filter(i=>i.id!==id);
    await persistCadastros(novos);
    setDeleteConfirm(null); showSaved();
  }
  async function addCadastro(tipo) {
    const key = tipo==="operadores"?"operador":tipo==="equipamentos"?"equipamento":tipo==="cores"?"cor":tipo==="fornos"?"forno":"tipo";
    const campo = novoCadastro[key];
    if (!campo.nome) return alert("Informe o nome.");
    const novos = { ...cadastros };
    const nextId = Math.max(...novos[tipo].map(i=>i.id),0)+1;
    novos[tipo].push({ id:nextId, ...campo, status:"Ativo" });
    novos[tipo].sort((a,b)=>a.nome.localeCompare(b.nome));
    await persistCadastros(novos);
    setNovoCadastro(p=>({...p,[key]:tipo==="operadores"?{nome:"",setor:"Corte"}:tipo==="equipamentos"?{nome:"",setor:"Corte"}:tipo==="cores"?{nome:"",custo_kg:""}:{nome:""}}));
    showSaved();
  }

  // ============================================================
  // REGISTROS
  // ============================================================
  function getRegistros() {
    const regs = [];
    projeto.filter(p=>!p.em_andamento).forEach(p=>
      regs.push({ id:`P-${p.id}`, _id:p.id, _tipo:"projeto", data:p.data, setor:"Projeto",
        operador:p.operador, equipamento:"-", sku:p.sku, op:p.op||"-", tipo:p.tipo,
        quantidade:"-", horas:p.horas_total||0, kgs_tinta:null, status:p.status||"Ativo" })
    );
    // Corte: via itens
    corteItens.forEach(item=>{
      const ap = corte.find(c=>c.id===item.id_apontamento);
      if (ap) regs.push({ id:`C-${item.id_apontamento}-${item.sku}`, _id:ap.id, _tipo:"corte",
        data:ap.data, setor:"Corte", operador:ap.operador, equipamento:ap.equipamento||"-",
        sku:item.sku, op:ap.op||"-", quantidade:item.quantidade, horas:item.horas_rateadas||0,
        kgs_tinta:null, status:ap.status||"Ativo" });
    });
    // Solda: via itens
    soldaItens.forEach(item=>{
      const ap = solda.find(s=>s.id===item.id_apontamento_solda);
      if (ap) regs.push({ id:`S-${item.id_apontamento_solda}-${item.sku}`, _id:ap.id, _tipo:"solda",
        data:ap.data, setor:"Solda", operador:ap.operador, equipamento:"-",
        sku:item.sku, op:item.op||"-", quantidade:item.quantidade, horas:item.horas_rateadas||0,
        kgs_tinta:null, status:ap.status||"Ativo" });
    });
    // Fallback solda sem itens (legado)
    solda.filter(s=>!s.em_andamento&&!soldaItens.find(si=>si.id_apontamento_solda===s.id)).forEach(s=>
      regs.push({ id:`SF-${s.id}`, _id:s.id, _tipo:"solda", data:s.data, setor:"Solda",
        operador:s.operador, equipamento:"-", sku:(s._itens?.[0]?.sku||"-"), op:"-",
        quantidade:(s._itens?.[0]?.quantidade||"-"), horas:s.horas_total||0, kgs_tinta:null, status:s.status||"Ativo" })
    );
    pinturaItens.forEach(item=>{
      const f = pintura.find(p=>(p.id_fornada||p.id)===item.id_fornada);
      if (f) regs.push({ id:`PI-${item.id_fornada}-${item.sku}`, _id:f.id_fornada||f.id, _tipo:"pintura",
        data:f.data, setor:"Pintura", operador:"-", equipamento:f.forno||"-",
        sku:item.sku, op:item.op||"-", quantidade:item.quantidade, horas:item.horas_rateadas||0,
        kgs_tinta:item.kgs_rateados, status:f.status||"Ativo" });
    });
    return regs.sort((a,b)=>b.data.localeCompare(a.data));
  }

  const registros = getRegistros();
  const todosEquipamentos = [...new Set([
    ...cadastros.equipamentos.map(e=>e.nome),
    ...cadastros.fornos.map(f=>f.nome),
  ])].sort();
  const todosOperadoresLista = [...cadastros.operadores].sort((a,b)=>a.nome.localeCompare(b.nome));

  const filteredRegistros = registros.filter(r=>{
    if (r.status==="Inativo") return false;
    const okSku = !filterSku||String(r.sku).toLowerCase().includes(filterSku.toLowerCase());
    const okOp  = !filterOperador||r.operador===filterOperador;
    const okSet = !filterSetor||r.setor===filterSetor;
    const okEq  = !filterEquip||r.equipamento===filterEquip;
    return okSku&&okOp&&okSet&&okEq;
  });

  // ============================================================
  // DASHBOARD
  // ============================================================
  function getDashData(sku) {
    if (!sku) return null;
    const skuRegs = registros.filter(r=>String(r.sku)===String(sku)&&r.status!=="Inativo");
    if (!skuRegs.length) return null;
    let filtered = skuRegs;
    if (dashFilterSetor) filtered = filtered.filter(r=>r.setor===dashFilterSetor);
    if (dashFilterOp) filtered = filtered.filter(r=>r.operador===dashFilterOp);

    const proj = skuRegs.filter(r=>r.setor==="Projeto");
    const cort = skuRegs.filter(r=>r.setor==="Corte");
    const sold = skuRegs.filter(r=>r.setor==="Solda");
    const pint = skuRegs.filter(r=>r.setor==="Pintura");
    const sum = arr => arr.reduce((a,r)=>a+r.horas,0);

    const horasDesenvTotal = sum(proj);
    const tiposProjeto = {};
    proj.forEach(r=>{ tiposProjeto[r.tipo||"Sem tipo"]=(tiposProjeto[r.tipo||"Sem tipo"]||0)+r.horas; });

    const corteByEquip = {};
    cort.forEach(r=>{ const eq=r.equipamento||"-"; (corteByEquip[eq]=corteByEquip[eq]||[]).push(r.horas); });
    const mediaCorteEquip = {};
    Object.entries(corteByEquip).forEach(([eq,hrs])=>{ mediaCorteEquip[eq]=hrs.reduce((a,b)=>a+b,0)/hrs.length; });
    const mediaCorteTotal = Object.values(mediaCorteEquip).reduce((a,b)=>a+b,0);

    const mediaSolda = sold.length>0?sum(sold)/sold.length:0;
    const mediaPintH = pint.length>0?sum(pint)/pint.length:0;
    const mediaPintKg = pint.length>0?pint.reduce((a,r)=>a+(r.kgs_tinta||0),0)/pint.length:0;

    const opsSolda = {};
    sold.forEach(r=>{ opsSolda[r.operador]=(opsSolda[r.operador]||0)+1; });
    const topOpsSolda = Object.entries(opsSolda).sort((a,b)=>b[1]-a[1]).slice(0,3);

    const historico = filtered.slice().sort((a,b)=>b.data.localeCompare(a.data));
    return { horasDesenvTotal, tiposProjeto, mediaCorteTotal, mediaCorteEquip,
             mediaSolda, mediaPintH, mediaPintKg, topOpsSolda, historico, projCount:proj.length };
  }
  const dashData = searchSku ? getDashData(searchSku) : null;

  // ============================================================
  // EM ANDAMENTO
  // ============================================================
  const projetoAnd = projeto.filter(p=>p.em_andamento);
  const corteAnd   = corte.filter(c=>c.em_andamento);
  const soldaAnd   = solda.filter(s=>s.em_andamento);
  const pinturaAnd = pintura.filter(p=>p.em_andamento);

  // Colunas kanban sempre presentes (ordenadas alfa)
  const colsProj = [...new Set([...cadastros.operadores.filter(o=>o.setor==="Projeto"&&o.status==="Ativo").map(o=>o.nome).sort()])];
  const colsCorte = [...new Set([...cadastros.equipamentos.filter(e=>e.status==="Ativo").map(e=>e.nome).sort()])];
  const colsSolda = [...new Set([...cadastros.operadores.filter(o=>o.setor==="Solda"&&o.status==="Ativo").map(o=>o.nome).sort()])];
  const colsPint  = [...new Set([...cadastros.fornos.filter(f=>f.status==="Ativo").map(f=>f.nome).sort()])];

  const totalAndamento = projetoAnd.length+corteAnd.length+soldaAnd.length+pinturaAnd.length;

  // ============================================================
  // KANBAN
  // ============================================================
  function KanbanCard({ tipo, reg }) {
    const itens = reg._itens||[];
    const primSku = reg.sku||(itens[0]?.sku)||"-";
    const primDesc = reg.descricao||(itens[0]?.descricao)||"";
    const primQtd = reg.quantidade||(itens[0]?.quantidade)||"-";
    const primOp = reg.op||(itens[0]?.op)||"-";
    const cor = STXT[{projeto:"Projeto",corte:"Corte",solda:"Solda",pintura:"Pintura"}[tipo]||"Projeto"];
    return (
      <div style={{ background:"#252525", border:`1px solid #3a3a3a`, borderRadius:10, padding:14, marginBottom:10, borderLeft:`3px solid ${cor}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
          <span style={{ fontWeight:700, color:"#E57B25", fontSize:14 }}>SKU {primSku}</span>
          {primOp!=="-"&&<span style={{ fontSize:11, color:"#9ca3af", background:"#1a1a1a", padding:"2px 6px", borderRadius:4 }}>OP {primOp}</span>}
        </div>
        {primDesc&&<p style={{ fontSize:12, color:"#9ca3af", margin:"0 0 6px" }}>{primDesc}</p>}
        {itens.length>1&&<p style={{ fontSize:11, color:"#6b7280", margin:"0 0 6px" }}>+{itens.length-1} SKU(s) adicionais</p>}
        <div style={{ fontSize:12, color:"#d1d5db", marginBottom:8 }}>
          {primQtd!=="-"&&<span>Qtd: <strong>{primQtd}</strong> · </span>}
          <span style={{ color:"#6b7280" }}>Início: {reg.data} {reg.hora_inicio}</span>
        </div>
        <button onClick={()=>abrirFinalizar(tipo,reg)} style={{ ...S.btnGreen, width:"100%", padding:"7px", fontSize:12 }}>
          ✓ Finalizar
        </button>
      </div>
    );
  }

  function KanbanLane({ titulo, colunas, registros:regs, tipo, cor }) {
    const grupos = {};
    colunas.forEach(c=>{ grupos[c]=[]; });
    regs.forEach(r=>{
      const key = tipo==="corte"?(r.equipamento||"-"):tipo==="pintura"?(r.forno||"-"):(r.operador||"-");
      if (!grupos[key]) grupos[key]=[];
      grupos[key].push(r);
    });
    return (
      <div style={{ marginBottom:32 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
          <div style={{ width:4, height:20, background:cor, borderRadius:2 }} />
          <h3 style={{ margin:0, fontSize:15, fontWeight:700, color:"#fff" }}>{titulo}</h3>
          <span style={{ fontSize:12, color:"#6b7280", background:"#2a2a2a", padding:"2px 8px", borderRadius:4 }}>{regs.length} em andamento</span>
        </div>
        <div style={{ display:"flex", gap:12, overflowX:"auto", paddingBottom:8 }}>
          {Object.entries(grupos).map(([col,items])=>(
            <div key={col} style={{ minWidth:200, maxWidth:230, flex:"0 0 215px" }}>
              <div style={{ fontSize:12, fontWeight:600, color:cor, marginBottom:8, padding:"5px 0", borderBottom:`1px solid ${cor}33` }}>
                {col} <span style={{ color:"#6b7280" }}>({items.length})</span>
              </div>
              {items.length===0
                ? <div style={{ padding:"16px 0", color:"#3a3a3a", fontSize:12, textAlign:"center" }}>—</div>
                : items.map((r,i)=><KanbanCard key={i} tipo={tipo} reg={r} />)
              }
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ============================================================
  // EXPORTAR
  // ============================================================
  function exportarApontamentos() {
    const projFin = projeto.filter(p=>!p.em_andamento);
    const corteFin = corte.filter(c=>!c.em_andamento);
    const soldaFin = solda.filter(s=>!s.em_andamento);
    const pintFin  = pintura.filter(p=>!p.em_andamento);
    exportToCSV([["ID","Data","Data_Termino","Operador","Tipo","SKU","OP","Descricao","Hora_Inicio","Hora_Termino","Horas_Extras","Horas_Total","Status"],
      ...projFin.map(p=>[p.id,p.data,p.data_termino,p.operador,p.tipo,p.sku,p.op,p.descricao,p.hora_inicio,p.hora_termino,p.horas_extras,p.horas_total,p.status])
    ],"Apontamentos_Projeto.csv");
    setTimeout(()=>exportToCSV([["ID","Data","Data_Termino","Operador","Equipamento","OP","Hora_Inicio","Hora_Termino","Horas_Extras","Horas_Total","Status"],
      ...corteFin.map(c=>[c.id,c.data,c.data_termino,c.operador,c.equipamento,c.op,c.hora_inicio,c.hora_termino,c.horas_extras,c.horas_total,c.status])
    ],"Apontamentos_Corte.csv"),200);
    setTimeout(()=>exportToCSV([["ID_Apontamento","SKU","Descricao","Quantidade","Horas_Rateadas","Status"],
      ...corteItens.map(i=>[i.id_apontamento,i.sku,i.descricao,i.quantidade,i.horas_rateadas,i.status])
    ],"Apontamentos_Corte_Itens.csv"),400);
    setTimeout(()=>exportToCSV([["ID","Data","Data_Termino","Operador","Hora_Inicio","Hora_Termino","Horas_Extras","Horas_Total","Status"],
      ...soldaFin.map(s=>[s.id,s.data,s.data_termino,s.operador,s.hora_inicio,s.hora_termino,s.horas_extras,s.horas_total,s.status])
    ],"Apontamentos_Solda.csv"),600);
    setTimeout(()=>exportToCSV([["ID_Apontamento_Solda","SKU","Descricao","OP","Quantidade","Horas_Rateadas","Status"],
      ...soldaItens.map(i=>[i.id_apontamento_solda,i.sku,i.descricao,i.op,i.quantidade,i.horas_rateadas,i.status])
    ],"Apontamentos_Solda_Itens.csv"),800);
    setTimeout(()=>exportToCSV([["ID_Fornada","Data","Data_Termino","Forno","Cor","Kgs_Tinta","Hora_Inicio","Hora_Termino","Horas_Extras","Horas_Total","Status"],
      ...pintFin.map(p=>[p.id_fornada||p.id,p.data,p.data_termino,p.forno,p.cor,p.kgs_tinta,p.hora_inicio,p.hora_termino,p.horas_extras,p.horas_total,p.status])
    ],"Apontamentos_Pintura.csv"),1000);
    setTimeout(()=>exportToCSV([["ID_Fornada","SKU","Descricao","OP","Quantidade","Horas_Rateadas","Kgs_Rateados","Status"],
      ...pinturaItens.map(i=>[i.id_fornada,i.sku,i.descricao,i.op,i.quantidade,i.horas_rateadas,i.kgs_rateados,i.status])
    ],"Apontamentos_Pintura_Itens.csv"),1200);
  }
  function exportarCadastros() {
    exportToCSV([["Nome","Setor","Status"],...cadastros.operadores.map(o=>[o.nome,o.setor,o.status])],"Operadores.csv");
    setTimeout(()=>exportToCSV([["Nome","Setor","Status"],...cadastros.equipamentos.map(e=>[e.nome,e.setor,e.status])],"Equipamentos.csv"),200);
    setTimeout(()=>exportToCSV([["Nome","Custo_Kg","Status"],...cadastros.cores.map(c=>[c.nome,c.custo_kg,c.status])],"Cores.csv"),400);
    setTimeout(()=>exportToCSV([["Nome","Status"],...cadastros.fornos.map(f=>[f.nome,f.status])],"Fornos.csv"),600);
    setTimeout(()=>exportToCSV([["Nome","Status"],...cadastros.tipos.map(t=>[t.nome,t.status])],"Tipos.csv"),800);
  }

  // ============================================================
  // PREVIEW HORAS helper
  // ============================================================
  function PreviewHoras({ dtI, hI, dtT, hT, extras, ehPintura }) {
    const h = previewHoras(dtI, hI, dtT, hT, extras, ehPintura);
    if (h === null) return null;
    return (
      <div style={{ marginTop:12, padding:"10px 14px", background:"#2a2a2a", borderRadius:8, borderLeft:"4px solid #E57B25" }}>
        <span style={{ color:"#E57B25", fontWeight:700 }}>⏱ Total: {h.toFixed(2)}h</span>
        {!ehPintura && <ExpedienteNote />}
        {ehPintura && <span style={{ color:"#6b7280", fontSize:11, marginLeft:8 }}>(sem filtro de expediente)</span>}
      </div>
    );
  }

  // ============================================================
  // LOADING
  // ============================================================
  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh", background:"#292929" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:48, marginBottom:16 }}>⏳</div>
        <p style={{ fontSize:16, color:"#E57B25", fontWeight:600 }}>Carregando sistema...</p>
      </div>
    </div>
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div style={{ fontFamily:"system-ui, sans-serif", minHeight:"100vh", background:"#292929" }}>

      {/* HEADER */}
      <div style={{ background:"linear-gradient(135deg,#154766,#1a5a7f)", padding:"16px 28px", color:"#fff", boxShadow:"0 4px 12px rgba(0,0,0,0.3)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <h1 style={{ margin:0, fontSize:21, fontWeight:700 }}>🏭 Sistema de Apontamento de Horas</h1>
            <p style={{ margin:"3px 0 0", opacity:0.75, fontSize:12 }}>Gestão de Produção por SKU · Supabase · v4</p>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            {dbError && <span style={{ background:"#ef4444", padding:"5px 10px", borderRadius:6, fontWeight:700, fontSize:12 }}>⚠ Offline</span>}
            {saved  && <span style={{ background:"#10b981", padding:"5px 10px", borderRadius:6, fontWeight:700, fontSize:12 }}>✓ Salvo!</span>}
          </div>
        </div>
      </div>

      {/* TABS */}
      <div style={{ background:"#1f1f1f", borderBottom:"2px solid #E57B25", display:"flex", padding:"0 20px", overflowX:"auto" }}>
        {[["novo","➕ Novo"],["andamento",`⏳ Em Andamento${totalAndamento>0?` (${totalAndamento})`:""}`],["registros","📋 Registros"],["resumo","📊 Dashboard"],["cadastros","⚙️ Cadastros"],["exportar","📥 Exportar"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{ padding:"12px 16px", fontSize:13, fontWeight:600, border:"none", background:"none", cursor:"pointer", color:tab===k?"#E57B25":"#9ca3af", whiteSpace:"nowrap", borderBottom:tab===k?"3px solid #E57B25":"3px solid transparent" }}>{l}</button>
        ))}
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"22px 18px" }}>

        {/* ============================= NOVO ============================= */}
        {tab==="novo" && (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:18 }}>
              {["Projeto","Corte","Solda","Pintura"].map(s=>(
                <button key={s} onClick={()=>setSetor(s)} style={{ padding:"14px", borderRadius:10, border:setor===s?"2px solid #E57B25":"2px solid #3a3a3a", background:setor===s?"#1a1a1a":"#2a2a2a", cursor:"pointer", fontWeight:700, fontSize:13, color:setor===s?"#E57B25":"#9ca3af", boxShadow:setor===s?"0 0 16px rgba(229,123,37,0.2)":"none" }}>
                  {s==="Projeto"?"📝":s==="Corte"?"✂️":s==="Solda"?"🔧":"🎨"} {s}
                </button>
              ))}
            </div>

            <div style={{ ...S.card, padding:26 }}>

              {/* PROJETO */}
              {setor==="Projeto" && (() => {
                const f = formProjeto;
                const set = v => setFormProjeto(p=>({...p,...v}));
                return (
                  <div>
                    <h2 style={{ fontSize:17, fontWeight:700, marginBottom:20, color:"#E57B25" }}>📝 Apontamento · Projeto</h2>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14 }}>
                      <Field label="Data Início"><input type="date" style={S.inp} value={f.data} onChange={e=>set({data:e.target.value})} /></Field>
                      <Field label="Operador *">
                        <select style={S.inp} value={f.operador} onChange={e=>set({operador:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.operadores.filter(o=>o.setor==="Projeto"&&o.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(o=><option key={o.id} value={o.nome}>{o.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="Tipo *">
                        <select style={S.inp} value={f.tipo} onChange={e=>set({tipo:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.tipos.filter(t=>t.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(t=><option key={t.id} value={t.nome}>{t.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="SKU *"><input style={S.inp} placeholder="Ex: 12345" value={f.sku} onChange={e=>set({sku:e.target.value})} /></Field>
                      <Field label="OP"><input style={S.inp} placeholder="Número da OP" value={f.op} onChange={e=>set({op:e.target.value})} /></Field>
                      <Field label="Descrição do item/SKU"><input style={S.inp} placeholder="Descrição do produto" value={f.descricao} onChange={e=>set({descricao:e.target.value})} /></Field>
                      <Field label="Hora Início *"><input type="time" style={S.inp} value={f.hora_inicio} onChange={e=>set({hora_inicio:e.target.value})} /></Field>
                      <div>
                        <Field label="Data Término"><input type="date" style={S.inp} value={f.data_termino} onChange={e=>set({data_termino:e.target.value})} /></Field>
                      </div>
                      <div>
                        <Field label="Hora Término"><input type="time" style={S.inp} value={f.hora_termino} onChange={e=>set({hora_termino:e.target.value})} /></Field>
                        <HintAndamento />
                      </div>
                      <Field label="Horas Extras"><input type="number" step="0.5" min="0" style={S.inp} placeholder="0" value={f.horas_extras} onChange={e=>set({horas_extras:e.target.value})} /></Field>
                    </div>
                    <PreviewHoras dtI={f.data} hI={f.hora_inicio} dtT={f.hora_termino?(f.data_termino||f.data):null} hT={f.hora_termino} extras={f.horas_extras} ehPintura={false} />
                    <div style={{ marginTop:18 }}><button style={S.btn} onClick={openConfirmProjeto}>Revisar e Salvar →</button></div>
                  </div>
                );
              })()}

              {/* CORTE */}
              {setor==="Corte" && (() => {
                const f = formCorte;
                const set = v => setFormCorte(p=>({...p,...v}));
                const updItem = (i,k,v) => { const n=[...f.itens]; n[i]={...n[i],[k]:v}; set({itens:n}); };
                return (
                  <div>
                    <h2 style={{ fontSize:17, fontWeight:700, marginBottom:20, color:"#E57B25" }}>✂️ Apontamento · Corte</h2>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14, marginBottom:18 }}>
                      <Field label="Data Início"><input type="date" style={S.inp} value={f.data} onChange={e=>set({data:e.target.value})} /></Field>
                      <Field label="Operador *">
                        <select style={S.inp} value={f.operador} onChange={e=>set({operador:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.operadores.filter(o=>o.setor==="Corte"&&o.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(o=><option key={o.id} value={o.nome}>{o.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="Equipamento">
                        <select style={S.inp} value={f.equipamento} onChange={e=>set({equipamento:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.equipamentos.filter(e=>e.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(e=><option key={e.id} value={e.nome}>{e.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="OP Geral"><input style={S.inp} placeholder="OP do lote" value={f.op} onChange={e=>set({op:e.target.value})} /></Field>
                    </div>
                    <div style={{ background:"#2a2a2a", padding:14, borderRadius:10, marginBottom:16, border:"1px solid #3a3a3a" }}>
                      <h3 style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"#E57B25" }}>SKUs (até 5) *</h3>
                      <ItemRows itens={f.itens} onChange={(i,k,v)=>updItem(i,k,v)} onAdd={()=>set({itens:[...f.itens,emptyItem()]})} onRemove={i=>set({itens:f.itens.filter((_,idx)=>idx!==i)})} />
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14 }}>
                      <Field label="Hora Início *"><input type="time" style={S.inp} value={f.hora_inicio} onChange={e=>set({hora_inicio:e.target.value})} /></Field>
                      <div>
                        <Field label="Data Término"><input type="date" style={S.inp} value={f.data_termino} onChange={e=>set({data_termino:e.target.value})} /></Field>
                      </div>
                      <div>
                        <Field label="Hora Término"><input type="time" style={S.inp} value={f.hora_termino} onChange={e=>set({hora_termino:e.target.value})} /></Field>
                        <HintAndamento />
                      </div>
                      <Field label="Horas Extras"><input type="number" step="0.5" min="0" style={S.inp} placeholder="0" value={f.horas_extras} onChange={e=>set({horas_extras:e.target.value})} /></Field>
                    </div>
                    <PreviewHoras dtI={f.data} hI={f.hora_inicio} dtT={f.hora_termino?(f.data_termino||f.data):null} hT={f.hora_termino} extras={f.horas_extras} ehPintura={false} />
                    <div style={{ marginTop:18 }}><button style={S.btn} onClick={openConfirmCorte}>Revisar e Salvar →</button></div>
                  </div>
                );
              })()}

              {/* SOLDA */}
              {setor==="Solda" && (() => {
                const f = formSolda;
                const set = v => setFormSolda(p=>({...p,...v}));
                const updItem = (i,k,v) => { const n=[...f.itens]; n[i]={...n[i],[k]:v}; set({itens:n}); };
                return (
                  <div>
                    <h2 style={{ fontSize:17, fontWeight:700, marginBottom:20, color:"#E57B25" }}>🔧 Apontamento · Solda</h2>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:18 }}>
                      <Field label="Data Início"><input type="date" style={S.inp} value={f.data} onChange={e=>set({data:e.target.value})} /></Field>
                      <Field label="Operador *">
                        <select style={S.inp} value={f.operador} onChange={e=>set({operador:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.operadores.filter(o=>o.setor==="Solda"&&o.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(o=><option key={o.id} value={o.nome}>{o.nome}</option>)}
                        </select>
                      </Field>
                    </div>
                    <div style={{ background:"#2a2a2a", padding:14, borderRadius:10, marginBottom:16, border:"1px solid #3a3a3a" }}>
                      <h3 style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"#E57B25" }}>SKUs e OPs (até 5) *</h3>
                      <ItemRows itens={f.itens} onChange={(i,k,v)=>updItem(i,k,v)} onAdd={()=>set({itens:[...f.itens,emptyItem()]})} onRemove={i=>set({itens:f.itens.filter((_,idx)=>idx!==i)})} placeholder="SKU" />
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14 }}>
                      <Field label="Hora Início *"><input type="time" style={S.inp} value={f.hora_inicio} onChange={e=>set({hora_inicio:e.target.value})} /></Field>
                      <div>
                        <Field label="Data Término"><input type="date" style={S.inp} value={f.data_termino} onChange={e=>set({data_termino:e.target.value})} /></Field>
                      </div>
                      <div>
                        <Field label="Hora Término"><input type="time" style={S.inp} value={f.hora_termino} onChange={e=>set({hora_termino:e.target.value})} /></Field>
                        <HintAndamento />
                      </div>
                      <Field label="Horas Extras"><input type="number" step="0.5" min="0" style={S.inp} placeholder="0" value={f.horas_extras} onChange={e=>set({horas_extras:e.target.value})} /></Field>
                    </div>
                    <PreviewHoras dtI={f.data} hI={f.hora_inicio} dtT={f.hora_termino?(f.data_termino||f.data):null} hT={f.hora_termino} extras={f.horas_extras} ehPintura={false} />
                    <div style={{ marginTop:18 }}><button style={S.btn} onClick={openConfirmSolda}>Revisar e Salvar →</button></div>
                  </div>
                );
              })()}

              {/* PINTURA */}
              {setor==="Pintura" && (() => {
                const f = formPintura;
                const set = v => setFormPintura(p=>({...p,...v}));
                const updItem = (i,k,v) => { const n=[...f.itens]; n[i]={...n[i],[k]:v}; set({itens:n}); };
                return (
                  <div>
                    <h2 style={{ fontSize:17, fontWeight:700, marginBottom:20, color:"#E57B25" }}>🎨 Apontamento · Pintura Eletrostática</h2>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14, marginBottom:18 }}>
                      <Field label="Data Início"><input type="date" style={S.inp} value={f.data} onChange={e=>set({data:e.target.value})} /></Field>
                      <Field label="Forno *">
                        <select style={S.inp} value={f.forno} onChange={e=>set({forno:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.fornos.filter(f=>f.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(f=><option key={f.id} value={f.nome}>{f.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="Cor *">
                        <select style={S.inp} value={f.cor} onChange={e=>set({cor:e.target.value})}>
                          <option value="">Selecione</option>
                          {cadastros.cores.filter(c=>c.status==="Ativo").sort((a,b)=>a.nome.localeCompare(b.nome)).map(c=><option key={c.id} value={c.nome}>{c.nome}</option>)}
                        </select>
                      </Field>
                      <Field label="Kgs de Tinta"><input type="number" step="0.01" style={S.inp} placeholder="0.00" value={f.kgs_tinta} onChange={e=>set({kgs_tinta:e.target.value})} /></Field>
                    </div>
                    <div style={{ background:"#2a2a2a", padding:14, borderRadius:10, marginBottom:16, border:"1px solid #3a3a3a" }}>
                      <h3 style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"#E57B25" }}>SKUs da Fornada (até 5) *</h3>
                      <ItemRows itens={f.itens} onChange={(i,k,v)=>updItem(i,k,v)} onAdd={()=>set({itens:[...f.itens,emptyItem()]})} onRemove={i=>set({itens:f.itens.filter((_,idx)=>idx!==i)})} placeholder="SKU" />
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14 }}>
                      <Field label="Hora Início *"><input type="time" style={S.inp} value={f.hora_inicio} onChange={e=>set({hora_inicio:e.target.value})} /></Field>
                      <div>
                        <Field label="Data Término"><input type="date" style={S.inp} value={f.data_termino} onChange={e=>set({data_termino:e.target.value})} /></Field>
                      </div>
                      <div>
                        <Field label="Hora Término"><input type="time" style={S.inp} value={f.hora_termino} onChange={e=>set({hora_termino:e.target.value})} /></Field>
                        <HintAndamento />
                      </div>
                      <Field label="Horas Extras"><input type="number" step="0.5" min="0" style={S.inp} placeholder="0" value={f.horas_extras} onChange={e=>set({horas_extras:e.target.value})} /></Field>
                    </div>
                    <PreviewHoras dtI={f.data} hI={f.hora_inicio} dtT={f.hora_termino?(f.data_termino||f.data):null} hT={f.hora_termino} extras={f.horas_extras} ehPintura={true} />
                    <div style={{ marginTop:18 }}><button style={S.btn} onClick={openConfirmPintura}>Revisar e Salvar →</button></div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* ============================= EM ANDAMENTO ============================= */}
        {tab==="andamento" && (
          <div>
            <div style={{ ...S.card, marginBottom:22, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <h2 style={{ margin:0, fontSize:17, fontWeight:700, color:"#E57B25" }}>⏳ Em Andamento</h2>
                <p style={{ margin:"4px 0 0", fontSize:12, color:"#6b7280" }}>Apontamentos sem hora de término. Clique "Finalizar" para encerrar.</p>
              </div>
              <span style={{ fontSize:24, fontWeight:700, color:"#E57B25" }}>{totalAndamento}</span>
            </div>
            <KanbanLane titulo="📝 Projeto" colunas={colsProj} registros={projetoAnd} tipo="projeto" cor={STXT.Projeto} />
            <KanbanLane titulo="✂️ Corte"   colunas={colsCorte} registros={corteAnd}   tipo="corte"   cor={STXT.Corte} />
            <KanbanLane titulo="🔧 Solda"   colunas={colsSolda} registros={soldaAnd}   tipo="solda"   cor={STXT.Solda} />
            <KanbanLane titulo="🎨 Pintura" colunas={colsPint}  registros={pinturaAnd} tipo="pintura" cor={STXT.Pintura} />
          </div>
        )}

        {/* ============================= REGISTROS ============================= */}
        {tab==="registros" && (
          <div>
            <div style={{ ...S.card, marginBottom:12 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12 }}>
                <div><span style={S.label}>SKU</span><input style={S.inp} placeholder="Filtrar SKU..." value={filterSku} onChange={e=>setFilterSku(e.target.value)} /></div>
                <div>
                  <span style={S.label}>Operador</span>
                  <select style={S.inp} value={filterOperador} onChange={e=>setFilterOperador(e.target.value)}>
                    <option value="">Todos</option>
                    {todosOperadoresLista.map(o=><option key={o.id} value={o.nome}>{o.nome}</option>)}
                  </select>
                </div>
                <div>
                  <span style={S.label}>Setor</span>
                  <select style={S.inp} value={filterSetor} onChange={e=>setFilterSetor(e.target.value)}>
                    <option value="">Todos</option>
                    {["Projeto","Corte","Solda","Pintura"].map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <span style={S.label}>Equipamento / Forno</span>
                  <select style={S.inp} value={filterEquip} onChange={e=>setFilterEquip(e.target.value)}>
                    <option value="">Todos</option>
                    {todosEquipamentos.map(e=><option key={e} value={e}>{e}</option>)}
                  </select>
                </div>
              </div>
            </div>
            {filteredRegistros.length===0 ? (
              <div style={{ ...S.card, textAlign:"center", padding:44 }}>
                <p style={{ fontSize:32 }}>🔭</p>
                <p style={{ color:"#9ca3af" }}>{registros.length===0?"Nenhum apontamento registrado ainda.":"Nenhum resultado."}</p>
              </div>
            ) : (
              <div style={{ background:"#1f1f1f", borderRadius:12, overflow:"hidden", border:"1px solid #3a3a3a" }}>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                    <thead>
                      <tr style={{ background:"#2a2a2a" }}>
                        {["Data","Setor","Operador","Equipamento","SKU","OP","Qtd","Horas","Kgs","Ações"].map(h=>(
                          <th key={h} style={{ padding:"12px 12px", textAlign:"left", fontWeight:600, color:"#E57B25", whiteSpace:"nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRegistros.map((r,i)=>(
                        <tr key={r.id} style={{ borderTop:"1px solid #3a3a3a", background:i%2===0?"#1f1f1f":"#232323" }}>
                          <td style={{ padding:"10px 12px", color:"#9ca3af", whiteSpace:"nowrap" }}>{r.data}</td>
                          <td style={{ padding:"10px 12px" }}><span style={{ background:SBG[r.setor], color:STXT[r.setor], padding:"3px 8px", borderRadius:5, fontSize:11, fontWeight:600 }}>{r.setor}</span></td>
                          <td style={{ padding:"10px 12px", color:"#fff" }}>{r.operador}</td>
                          <td style={{ padding:"10px 12px", color:"#9ca3af" }}>{r.equipamento}</td>
                          <td style={{ padding:"10px 12px", fontWeight:700, color:"#E57B25" }}>{r.sku}</td>
                          <td style={{ padding:"10px 12px", color:"#9ca3af" }}>{r.op!=="-"?r.op:"-"}</td>
                          <td style={{ padding:"10px 12px", color:"#fff" }}>{r.quantidade!=="-"&&r.quantidade!=null?r.quantidade:"-"}</td>
                          <td style={{ padding:"10px 12px", fontWeight:600, color:"#10b981" }}>{r.horas.toFixed(2)}h</td>
                          <td style={{ padding:"10px 12px", color:"#fff" }}>{r.kgs_tinta!=null?r.kgs_tinta.toFixed(2)+"kg":"-"}</td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}>
                            <button onClick={()=>setEditRecModal({tipo:r._tipo,id:r._id,campos:{sku:r.sku,op:r.op}})} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, marginRight:6 }} title="Editar">✏️</button>
                            <button onClick={()=>setInativarModal({tipo:r._tipo,id:r._id,sku:r.sku})} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }} title="Inativar">🚫</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding:"11px 12px", background:"#2a2a2a", fontSize:13, color:"#9ca3af" }}>
                  <strong style={{ color:"#E57B25" }}>{filteredRegistros.length}</strong> registro(s) · Total horas: <strong style={{ color:"#10b981" }}>{filteredRegistros.reduce((a,r)=>a+r.horas,0).toFixed(2)}h</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================= DASHBOARD ============================= */}
        {tab==="resumo" && (
          <div>
            <div style={{ ...S.card, marginBottom:16 }}>
              <span style={S.label}>🔍 Buscar por SKU</span>
              <input style={{ ...S.inp, fontSize:15 }} placeholder="Digite o SKU..." value={searchSku} onChange={e=>setSearchSku(e.target.value)} />
            </div>
            {dashData && (() => {
              const skuOps = [...new Set(registros.filter(r=>String(r.sku)===String(searchSku)&&r.status!=="Inativo").map(r=>r.operador).filter(o=>o&&o!=="-"))].sort();
              return (
                <div>
                  <div style={{ ...S.card, marginBottom:12, display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    <div><span style={S.label}>Filtrar Setor</span><select style={S.inp} value={dashFilterSetor} onChange={e=>setDashFilterSetor(e.target.value)}><option value="">Todos</option>{["Projeto","Corte","Solda","Pintura"].map(s=><option key={s}>{s}</option>)}</select></div>
                    <div><span style={S.label}>Filtrar Operador</span><select style={S.inp} value={dashFilterOp} onChange={e=>setDashFilterOp(e.target.value)}><option value="">Todos</option>{skuOps.map(o=><option key={o}>{o}</option>)}</select></div>
                  </div>

                  {/* Desenvolvimento */}
                  <div style={{ ...S.card, marginBottom:12, borderLeft:"4px solid #7dd3fc" }}>
                    <h3 style={{ margin:"0 0 14px", fontSize:14, fontWeight:700, color:"#7dd3fc" }}>🧠 Desenvolvimento</h3>
                    <div style={{ display:"flex", gap:18, flexWrap:"wrap", alignItems:"flex-start" }}>
                      <div style={{ background:"#2a2a2a", borderRadius:10, padding:"14px 20px", textAlign:"center", minWidth:120 }}>
                        <p style={{ margin:0, fontSize:11, color:"#9ca3af" }}>TOTAL HORAS</p>
                        <p style={{ margin:"6px 0 0", fontSize:28, fontWeight:700, color:"#7dd3fc" }}>{dashData.horasDesenvTotal.toFixed(1)}h</p>
                        <p style={{ margin:"2px 0 0", fontSize:11, color:"#6b7280" }}>{dashData.projCount} reg.</p>
                      </div>
                      <div style={{ flex:1, minWidth:180 }}>
                        <p style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase", marginBottom:8 }}>Por Tipo</p>
                        {Object.keys(dashData.tiposProjeto).length===0?<p style={{ fontSize:12, color:"#4b5563" }}>Sem registros</p>
                          :Object.entries(dashData.tiposProjeto).sort((a,b)=>b[1]-a[1]).map(([tipo,horas],i)=>(
                            <div key={tipo} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:7 }}>
                              <span style={{ fontSize:12, color:"#d1d5db", minWidth:155 }}><span style={{ color:"#4b5563", marginRight:5 }}>{i+1}.</span>{tipo}</span>
                              <div style={{ flex:1, background:"#3a3a3a", borderRadius:3, height:6 }}><div style={{ width:`${(horas/dashData.horasDesenvTotal)*100}%`, background:"#7dd3fc", height:"100%", borderRadius:3 }} /></div>
                              <span style={{ fontSize:12, fontWeight:700, color:"#7dd3fc", minWidth:48, textAlign:"right" }}>{horas.toFixed(2)}h</span>
                            </div>
                          ))
                        }
                      </div>
                    </div>
                  </div>

                  {/* Produção */}
                  <div style={{ ...S.card, marginBottom:12, borderLeft:"4px solid #fbbf24" }}>
                    <h3 style={{ margin:"0 0 14px", fontSize:14, fontWeight:700, color:"#fbbf24" }}>🏭 Produção</h3>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:16 }}>
                      {[["Média Corte",dashData.mediaCorteTotal.toFixed(2)+"h","#fbbf24"],["Média Solda",dashData.mediaSolda.toFixed(2)+"h","#f472b6"],["Média Pintura (h)",dashData.mediaPintH.toFixed(2)+"h","#6ee7b7"],["Média Pintura (kg)",dashData.mediaPintKg.toFixed(2)+"kg","#6ee7b7"]].map(([l,v,c])=>(
                        <div key={l} style={{ background:"#2a2a2a", borderRadius:9, padding:"12px 14px" }}>
                          <p style={{ margin:0, fontSize:10, color:"#9ca3af", textTransform:"uppercase" }}>{l}</p>
                          <p style={{ margin:"5px 0 0", fontSize:22, fontWeight:700, color:c }}>{v}</p>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>
                      <div>
                        <p style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase", marginBottom:8 }}>Corte por Equipamento</p>
                        {Object.keys(dashData.mediaCorteEquip).length===0?<p style={{ fontSize:12, color:"#4b5563" }}>Sem registros</p>
                          :Object.entries(dashData.mediaCorteEquip).map(([eq,h])=>(
                            <div key={eq} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid #3a3a3a" }}>
                              <span style={{ fontSize:12, color:"#9ca3af" }}>{eq}</span>
                              <span style={{ fontSize:12, fontWeight:700, color:"#fbbf24" }}>{h.toFixed(2)}h</span>
                            </div>
                          ))
                        }
                      </div>
                      <div>
                        <p style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase", marginBottom:8 }}>Solda · Top Operadores</p>
                        {dashData.topOpsSolda.length===0?<p style={{ fontSize:12, color:"#4b5563" }}>Sem registros</p>
                          :dashData.topOpsSolda.map(([op,cnt])=>(
                            <div key={op} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid #3a3a3a" }}>
                              <span style={{ fontSize:12, color:"#9ca3af" }}>{op}</span>
                              <span style={{ fontSize:12, fontWeight:700, color:"#f472b6" }}>{cnt} reg.</span>
                            </div>
                          ))
                        }
                      </div>
                    </div>
                  </div>

                  {/* Histórico */}
                  <div style={S.card}>
                    <h3 style={{ fontSize:15, fontWeight:700, marginBottom:12, color:"#E57B25" }}>📋 Histórico · SKU {searchSku}</h3>
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                        <thead><tr style={{ background:"#2a2a2a" }}>{["Data","Setor","Operador","Horas","Ações"].map(h=><th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, color:"#E57B25" }}>{h}</th>)}</tr></thead>
                        <tbody>
                          {dashData.historico.map((r,i)=>(
                            <tr key={i} style={{ borderTop:"1px solid #3a3a3a" }}>
                              <td style={{ padding:"8px 12px", color:"#9ca3af" }}>{r.data}</td>
                              <td style={{ padding:"8px 12px" }}><span style={{ background:SBG[r.setor], color:STXT[r.setor], padding:"2px 7px", borderRadius:4, fontSize:11 }}>{r.setor}</span></td>
                              <td style={{ padding:"8px 12px", color:"#fff" }}>{r.operador}</td>
                              <td style={{ padding:"8px 12px", fontWeight:600, color:"#10b981" }}>{r.horas.toFixed(2)}h</td>
                              <td style={{ padding:"8px 12px" }}>
                                <button onClick={()=>setInativarModal({tipo:r._tipo,id:r._id,sku:r.sku})} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13 }} title="Inativar">🚫</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}
            {!dashData&&searchSku&&<div style={{ ...S.card, textAlign:"center", padding:40 }}><p style={{ fontSize:30 }}>🔍</p><p style={{ color:"#9ca3af" }}>SKU <strong style={{ color:"#fff" }}>{searchSku}</strong> não encontrado.</p></div>}
            {!searchSku&&<div style={{ ...S.card, textAlign:"center", padding:40 }}><p style={{ fontSize:36 }}>📊</p><p style={{ color:"#9ca3af" }}>Digite um SKU para visualizar o dashboard</p></div>}
          </div>
        )}

        {/* ============================= CADASTROS ============================= */}
        {tab==="cadastros" && (
          <div style={{ display:"grid", gap:16 }}>
            {[{tipo:"operadores",emoji:"👤",label:"Operadores",key:"operador"},{tipo:"equipamentos",emoji:"🔧",label:"Equipamentos",key:"equipamento"},{tipo:"cores",emoji:"🎨",label:"Cores",key:"cor"},{tipo:"fornos",emoji:"🔥",label:"Fornos",key:"forno"},{tipo:"tipos",emoji:"📝",label:"Tipos de Projeto",key:"tipo"}].map(({tipo,emoji,label:l,key:k})=>{
              const items = [...cadastros[tipo]].sort((a,b)=>a.nome.localeCompare(b.nome));
              const grouped = tipo==="operadores"?Object.entries(items.reduce((acc,op)=>{(acc[op.setor]=acc[op.setor]||[]).push(op);return acc;},{})).sort((a,b)=>a[0].localeCompare(b[0])):null;
              return (
                <div key={tipo} style={S.card}>
                  <h3 style={{ fontSize:14, fontWeight:700, marginBottom:12, color:"#E57B25" }}>{emoji} {l}</h3>
                  <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
                    <input style={{ ...S.inp, flex:1, minWidth:130 }} placeholder="Nome" value={novoCadastro[k].nome} onChange={e=>setNovoCadastro(p=>({...p,[k]:{...p[k],nome:e.target.value}}))} />
                    {tipo==="operadores"&&<select style={{ ...S.inp, flex:1, minWidth:100 }} value={novoCadastro[k].setor} onChange={e=>setNovoCadastro(p=>({...p,[k]:{...p[k],setor:e.target.value}}))}>
                      <option value="Projeto">Projeto</option><option value="Corte">Corte</option><option value="Solda">Solda</option>
                    </select>}
                    {tipo==="cores"&&<input type="number" step="0.01" style={{ ...S.inp, flex:1, minWidth:100 }} placeholder="Custo/Kg R$" value={novoCadastro[k].custo_kg} onChange={e=>setNovoCadastro(p=>({...p,[k]:{...p[k],custo_kg:e.target.value}}))} />}
                    <button style={S.btn} onClick={()=>addCadastro(tipo)}>+ Adicionar</button>
                  </div>
                  {tipo==="operadores"&&grouped?grouped.map(([st,ops])=>(
                    <div key={st} style={{ marginBottom:12 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:STXT[st]||"#9ca3af", textTransform:"uppercase", letterSpacing:1, marginBottom:6, padding:"3px 0", borderBottom:`1px solid ${STXT[st]||"#3a3a3a"}33` }}>{st}</div>
                      {ops.map(item=><CadRow key={item.id} item={item} onEdit={()=>setEditModal({tipo,item:{...item}})} onDelete={()=>setDeleteConfirm({tipo,id:item.id,nome:item.nome})} />)}
                    </div>
                  ))
                  :items.map(item=><CadRow key={item.id} item={item} onEdit={()=>setEditModal({tipo,item:{...item}})} onDelete={()=>setDeleteConfirm({tipo,id:item.id,nome:item.nome})} />)}
                </div>
              );
            })}
          </div>
        )}

        {/* ============================= EXPORTAR ============================= */}
        {tab==="exportar" && (
          <div style={{ maxWidth:560, margin:"0 auto" }}>
            <div style={{ ...S.card, textAlign:"center", padding:32 }}>
              <h2 style={{ fontSize:19, fontWeight:700, marginBottom:8, color:"#E57B25" }}>📥 Exportar Dados</h2>
              <p style={{ color:"#9ca3af", marginBottom:24, fontSize:13 }}>Baixe todos os dados em CSV para Google Sheets ou Excel.</p>
              <div style={{ display:"grid", gap:10, marginBottom:24 }}>
                <button style={{ ...S.btn, padding:"13px", fontSize:14 }} onClick={exportarCadastros}>📊 Exportar Cadastros (5 arquivos)</button>
                <button style={{ ...S.btn, padding:"13px", fontSize:14 }} onClick={exportarApontamentos}>📈 Exportar Apontamentos (7 arquivos)</button>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[["Projeto",projeto.filter(p=>!p.em_andamento).length],["Corte (lotes)",corte.filter(c=>!c.em_andamento).length],["Corte (itens)",corteItens.length],["Solda",solda.filter(s=>!s.em_andamento).length],["Solda (itens)",soldaItens.length],["Pintura (fornadas)",pintura.filter(p=>!p.em_andamento).length],["Pintura (itens)",pinturaItens.length]].map(([ll,n])=>(
                  <div key={ll} style={{ background:"#2a2a2a", borderRadius:7, padding:"9px 12px", display:"flex", justifyContent:"space-between" }}>
                    <span style={{ fontSize:12, color:"#9ca3af" }}>{ll}</span><strong style={{ color:"#E57B25" }}>{n}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== MODAL CONFIRMAÇÃO ===== */}
      {confirmModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:500, width:"100%", border:"2px solid #E57B25", maxHeight:"90vh", overflowY:"auto" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:14, color:"#E57B25" }}>{confirmModal.emAndamento?"⏳ Vai para Em Andamento":"📋 Confirmar Apontamento"}</h2>
            {confirmModal.emAndamento&&<div style={{ background:"#2a1a0a", border:"1px solid #E57B25", borderRadius:8, padding:"9px 12px", marginBottom:14, fontSize:12, color:"#fbbf24" }}>Sem hora de término — ficará em <strong>"Em Andamento"</strong>.</div>}
            <div style={{ marginBottom:18 }}>
              {Object.entries(confirmModal.data).map(([k,v])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #3a3a3a" }}>
                  <span style={{ fontSize:12, color:"#9ca3af" }}>{k}</span>
                  <span style={{ fontSize:12, fontWeight:600, color:"#fff" }}>{v}</span>
                </div>
              ))}
              {confirmModal.itens&&<div style={{ marginTop:12 }}>
                <p style={{ fontSize:12, fontWeight:700, color:"#E57B25", marginBottom:7 }}>SKUs incluídos:</p>
                {confirmModal.itens.map((item,i)=><div key={i} style={{ fontSize:11, color:"#9ca3af", marginBottom:4, paddingLeft:10, borderLeft:"2px solid #3a3a3a" }}><strong style={{ color:"#fff" }}>{item.sku}</strong>{item.op&&<span style={{ color:"#E57B25" }}> OP:{item.op}</span>} · {item.descricao} · Qtd:{item.quantidade}</div>)}
              </div>}
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setConfirmModal(null)}>← Corrigir</button>
              <button style={{ ...S.btn, opacity:syncing?0.6:1 }} onClick={confirmarSalvar} disabled={syncing}>{syncing?"Salvando...":"✓ Confirmar"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODAL FINALIZAR ===== */}
      {finalizarModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:420, width:"100%", border:"2px solid #10b981" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:14, color:"#10b981" }}>✓ Finalizar Apontamento</h2>
            <p style={{ fontSize:12, color:"#9ca3af", marginBottom:16 }}>Início registrado: <strong style={{ color:"#fff" }}>{finalizarModal.registro.data} {finalizarModal.registro.hora_inicio}</strong></p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
              <div><span style={S.label}>Data Término *</span><input type="date" style={S.inp} value={finalizarModal.data_termino} onChange={e=>setFinalizarModal(m=>({...m,data_termino:e.target.value}))} /></div>
              <div><span style={S.label}>Hora Término *</span><input type="time" style={{ ...S.inp, fontSize:16 }} value={finalizarModal.hora_termino} onChange={e=>setFinalizarModal(m=>({...m,hora_termino:e.target.value}))} /></div>
            </div>
            <div style={{ marginBottom:14 }}>
              <span style={S.label}>Horas Extras</span>
              <input type="number" step="0.5" min="0" style={S.inp} placeholder="0" value={finalizarModal.horas_extras} onChange={e=>setFinalizarModal(m=>({...m,horas_extras:e.target.value}))} />
            </div>
            {finalizarModal.hora_termino && (() => {
              const ehPint = finalizarModal.tipo==="pintura";
              const h = calcHorasFinal(finalizarModal.registro.data, finalizarModal.registro.hora_inicio, finalizarModal.data_termino, finalizarModal.hora_termino, finalizarModal.horas_extras, ehPint);
              return <div style={{ background:"#2a2a2a", borderRadius:8, padding:"9px 12px", marginBottom:16, borderLeft:"4px solid #10b981" }}><span style={{ color:"#10b981", fontWeight:700 }}>⏱ Total calculado: {h.toFixed(2)}h</span></div>;
            })()}
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setFinalizarModal(null)}>Cancelar</button>
              <button style={{ ...S.btnGreen, opacity:syncing?0.6:1 }} onClick={confirmarFinalizar} disabled={syncing}>{syncing?"Salvando...":"✓ Confirmar"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODAL EDITAR REGISTRO ===== */}
      {editRecModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:400, width:"100%", border:"2px solid #154766" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:16, color:"#7dd3fc" }}>✏️ Editar Registro</h2>
            <div style={{ display:"grid", gap:12, marginBottom:20 }}>
              <div><span style={S.label}>SKU</span><input style={S.inp} value={editRecModal.campos.sku||""} onChange={e=>setEditRecModal(m=>({...m,campos:{...m.campos,sku:e.target.value}}))} /></div>
              <div><span style={S.label}>OP</span><input style={S.inp} value={editRecModal.campos.op||""} onChange={e=>setEditRecModal(m=>({...m,campos:{...m.campos,op:e.target.value}}))} /></div>
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setEditRecModal(null)}>Cancelar</button>
              <button style={S.btn} onClick={salvarEdicaoRegistro}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODAL INATIVAR ===== */}
      {inativarModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:360, width:"100%", border:"2px solid #ef4444" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:10, color:"#ef4444" }}>🚫 Inativar Registro</h2>
            <p style={{ color:"#9ca3af", marginBottom:20 }}>Inativar registro do SKU <strong style={{ color:"#fff" }}>{inativarModal.sku}</strong>? Ele não aparecerá mais nos relatórios.</p>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setInativarModal(null)}>Cancelar</button>
              <button style={S.btnDanger} onClick={confirmarInativar}>Inativar</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODAL EDIÇÃO CADASTRO ===== */}
      {editModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:400, width:"100%", border:"2px solid #154766" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:16, color:"#7dd3fc" }}>✏️ Editar Cadastro</h2>
            <div style={{ display:"grid", gap:12, marginBottom:20 }}>
              <div><span style={S.label}>Nome</span><input style={S.inp} value={editModal.item.nome} onChange={e=>setEditModal(m=>({...m,item:{...m.item,nome:e.target.value}}))} /></div>
              {editModal.item.setor!==undefined&&<div><span style={S.label}>Setor</span><select style={S.inp} value={editModal.item.setor} onChange={e=>setEditModal(m=>({...m,item:{...m.item,setor:e.target.value}}))}>
                <option value="Projeto">Projeto</option><option value="Corte">Corte</option><option value="Solda">Solda</option>
              </select></div>}
              {editModal.item.custo_kg!==undefined&&<div><span style={S.label}>Custo/Kg (R$)</span><input type="number" step="0.01" style={S.inp} value={editModal.item.custo_kg} onChange={e=>setEditModal(m=>({...m,item:{...m.item,custo_kg:parseFloat(e.target.value)||0}}))} /></div>}
              <div><span style={S.label}>Status</span><select style={S.inp} value={editModal.item.status} onChange={e=>setEditModal(m=>({...m,item:{...m.item,status:e.target.value}}))}>
                <option value="Ativo">Ativo</option><option value="Inativo">Inativo</option>
              </select></div>
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setEditModal(null)}>Cancelar</button>
              <button style={S.btn} onClick={saveCadastroEdit}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODAL EXCLUIR CADASTRO ===== */}
      {deleteConfirm && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
          <div style={{ background:"#1f1f1f", borderRadius:16, padding:26, maxWidth:340, width:"100%", border:"2px solid #ef4444" }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:10, color:"#ef4444" }}>🗑️ Confirmar Exclusão</h2>
            <p style={{ color:"#9ca3af", marginBottom:20 }}>Excluir <strong style={{ color:"#fff" }}>{deleteConfirm.nome}</strong>?</p>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={S.btnSec} onClick={()=>setDeleteConfirm(null)}>Cancelar</button>
              <button style={S.btnDanger} onClick={()=>deleteCadastro(deleteConfirm.tipo,deleteConfirm.id)}>Excluir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CadRow({ item, onEdit, onDelete }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 12px", background:"#2a2a2a", borderRadius:7, border:"1px solid #3a3a3a", marginBottom:5 }}>
      <span style={{ fontSize:13, color:"#fff" }}>
        <strong>{item.nome}</strong>
        {item.setor&&<span style={{ color:"#9ca3af", marginLeft:8 }}>· {item.setor}</span>}
        {item.custo_kg!==undefined&&<span style={{ color:"#E57B25", marginLeft:8 }}>· R$ {Number(item.custo_kg).toFixed(2)}/kg</span>}
        <span style={{ marginLeft:8, fontSize:11, padding:"2px 6px", borderRadius:4, background:item.status==="Ativo"?"#1a4a2a":"#4a1a1a", color:item.status==="Ativo"?"#6ee7b7":"#fca5a5" }}>{item.status}</span>
      </span>
      <div style={{ display:"flex", gap:6 }}>
        <button onClick={onEdit} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>✏️</button>
        <button onClick={onDelete} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>🗑️</button>
      </div>
    </div>
  );
}
