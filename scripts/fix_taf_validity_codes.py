from pathlib import Path

p = Path('taf.html')
s = p.read_text(encoding='utf-8')
original = s

# ICAO/TAF period formatting: an end time exactly at midnight is encoded as
# 24 on the preceding UTC day (e.g. 0712/0724), never as 0800.
old = "ddhh=t=>{let d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours())},ddhhmm=t=>"
new = "ddhh=t=>{let d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours())},ddhhEnd=t=>{let d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){let q=new Date(t-1);return pad(q.getUTCDate())+'24'}return ddhh(t)},ddhhmm=t=>"
if old in s:
    s = s.replace(old, new, 1)
elif 'ddhhEnd=t=>' not in s:
    raise SystemExit('ddhh helper hook not found')

# Human-readable cycle selector should also show 12-24 rather than 12-00.
old = "${pad(new Date(x.start).getUTCHours())}-${pad(new Date(x.end).getUTCHours())} UTC"
new = "${pad(new Date(x.start).getUTCHours())}-${new Date(x.end).getUTCHours()===0?'24':pad(new Date(x.end).getUTCHours())} UTC"
if old in s:
    s = s.replace(old, new, 1)

# Raw TAF validity and all change-group end times use DD24 when ending at midnight.
s = s.replace("${ddhh(c.start)}/${ddhh(c.end)}", "${ddhh(c.start)}/${ddhhEnd(c.end)}")
s = s.replace("${ddhh(g.s)}/${ddhh(g.e)}", "${ddhh(g.s)}/${ddhhEnd(g.e)}")
s = s.replace("${ddhh(s)}/${ddhh(e)}", "${ddhh(s)}/${ddhhEnd(e)}")

if "${ddhh(c.start)}/${ddhhEnd(c.end)}" not in s:
    raise SystemExit('TAF validity end formatter was not installed')
if "ddhhEnd=t=>" not in s:
    raise SystemExit('DD24 formatter missing')

if s != original:
    p.write_text(s, encoding='utf-8')
