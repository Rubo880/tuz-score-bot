export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const key = String(req.query.key || "");
  const safeKey = JSON.stringify(key);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#09090c">
<title>TUZ Leaderboard</title>
<style>
*{box-sizing:border-box}
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f7fb;background:#09090c}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 14% 0%,rgba(129,88,255,.23),transparent 34%),radial-gradient(circle at 95% 8%,rgba(255,199,62,.12),transparent 28%),#09090c;padding:22px}
.wrap{width:min(760px,100%);margin:0 auto}
.hero,.board{border:1px solid rgba(255,255,255,.10);background:rgba(22,22,29,.72);backdrop-filter:blur(22px);box-shadow:0 24px 80px rgba(0,0,0,.30)}
.hero{border-radius:30px;padding:27px 28px;margin-bottom:14px}
.eyebrow{font-size:11px;letter-spacing:.18em;color:#a99cff;font-weight:800}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#80ff91;box-shadow:0 0 0 5px rgba(128,255,145,.08);margin-right:7px}
h1{margin:8px 0 6px;font-size:clamp(38px,9vw,66px);line-height:.92;letter-spacing:-.065em}
.total{color:rgba(255,255,255,.58);font-size:13px}
.total b{color:#fff}
.board{border-radius:28px;padding:12px;overflow:hidden}
.row{display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:10px;padding:15px 14px;border-radius:18px}
.row+.row{border-top:1px solid rgba(255,255,255,.07);border-radius:0}
.rank{font-size:24px;text-align:center}
.name{font-weight:760;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.score{font-size:21px;font-weight:900;letter-spacing:-.03em}
.r1{background:linear-gradient(90deg,rgba(255,198,41,.16),transparent)}
.r2{background:linear-gradient(90deg,rgba(207,214,224,.12),transparent)}
.r3{background:linear-gradient(90deg,rgba(203,124,68,.13),transparent)}
.empty{padding:42px 18px;text-align:center;color:rgba(255,255,255,.48)}
footer{text-align:center;color:rgba(255,255,255,.32);font-size:11px;padding:18px}
</style>
</head>
<body>
<main class="wrap">
<section class="hero">
<div class="eyebrow"><span class="dot"></span>LIVE</div>
<h1 id="title">TUZ<br>Leaderboard</h1>
<div class="total">Всего упоминаний: <b id="total">—</b></div>
</section>
<section class="board" id="board"><div class="empty">Загрузка…</div></section>
<footer>Каждое «туз» / «tuz» = +1 · обновление автоматически</footer>
</main>
<script>
const key=${safeKey};
const medals=["🥇","🥈","🥉"];
function esc(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll(String.fromCharCode(34),"&quot;")
    .replaceAll("'","&#039;");
}
async function refresh(){
  try{
    const r=await fetch("/api/board?key="+encodeURIComponent(key),{cache:"no-store"});
    if(!r.ok) throw new Error("not found");
    const data=await r.json();
    document.title=data.title+" — TUZ Leaderboard";
    document.getElementById("title").innerHTML=esc(data.title)+"<br><span style='opacity:.45'>TUZ</span>";
    document.getElementById("total").textContent=data.total;
    const board=document.getElementById("board");
    if(!data.leaders.length){
      board.innerHTML="<div class='empty'>Пока ни одного упоминания.</div>";
      return;
    }
    board.innerHTML=data.leaders.map(x=>{
      const cls=x.rank<=3?" r"+x.rank:"";
      const rank=medals[x.rank-1]||x.rank+".";
      return "<div class='row"+cls+"'><div class='rank'>"+rank+"</div><div class='name'>"+esc(x.name)+"</div><div class='score'>"+x.score+"</div></div>";
    }).join("");
  }catch{
    document.getElementById("board").innerHTML="<div class='empty'>Лидерборд не найден.</div>";
  }
}
refresh();
setInterval(refresh,2000);
</script>
</body>
</html>`);
}
