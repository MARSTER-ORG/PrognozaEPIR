from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'MIFG integration hook not found: {label}')
    return text.replace(old, new, 1)


def patch_taf_page(path: Path) -> None:
    s = path.read_text(encoding='utf-8')

    s = replace_once(
        s,
        '<th>Mgła</th>',
        '<th>FG / MIFG</th>',
        'TAF hourly fog header',
    )

    s = replace_once(
        s,
        "wxm=txt.match(/\\b(?:\\+|-)?(?:FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\\b/g)||[]",
        "wxm=txt.match(/\\b(?:\\+|-)?(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\\b/g)||[]",
        'neighbor TAF MIFG parser',
    )

    s = replace_once(
        s,
        "let fog=w.PrognozaEPIRFogSeries||[],ot=Date.parse(obs?.metar?.obs_time||obs?.fused?.obs_time||obs?.updated_at||0)",
        "let fog=w.PrognozaEPIRFogSeries||[],mifg=[];try{if(w.PrognozaEPIRMIFG?.refresh)await w.PrognozaEPIRMIFG.refresh()}catch(_){ }try{let until=Date.now()+4e3;do{mifg=w.PrognozaEPIRMIFG?.getSeries?.()||[];if(mifg.length)break;await new Promise(r=>setTimeout(r,250))}while(Date.now()<until)}catch(_){ }let ot=Date.parse(obs?.metar?.obs_time||obs?.fused?.obs_time||obs?.updated_at||0)",
        'MIFG engine read',
    )

    s = replace_once(
        s,
        "let q=fog.find(x=>Math.abs((x.t||x.time||0)-z.t)<18e5);z.fogRisk=Math.max(q?.risk||q?.probability||0,trend());return windStats(z)",
        "let q=fog.find(x=>Math.abs((x.t||x.time||0)-z.t)<18e5),mq=mifg.find(x=>Math.abs((x.t||x.time||0)-z.t)<18e5);z.fogRisk=Math.max(q?.risk||q?.probability||0,trend());z.mifgRisk=fin(mq?.score)?mq.score:null;return windStats(z)",
        'hourly MIFG score',
    )

    s = replace_once(
        s,
        "function wx(z){if(z.fogRisk>=70&&z.VIS<=900)return z.T<=0?'FZFG':'FG';if(z.VIS>=1000&&z.VIS<=5000&&z.RH>=88)return'BR';if(z.storm>=50)return z.RR>=.1?'TSRA':'TS';if(z.RR>=.3)return'RA';if(z.RR>=.1)return'-RA';return''}",
        "function wx(z){if(z.fogRisk>=70&&z.VIS<=900)return z.T<=0?'FZFG':'FG';if(z.storm>=50)return z.RR>=.1?'TSRA':'TS';if(z.RR>=.3)return'RA';if(fin(z.mifgRisk)&&z.mifgRisk>=70)return'MIFG';if(z.VIS>=1000&&z.VIS<=5000&&z.RH>=88)return'BR';if(z.RR>=.1)return'-RA';return''}",
        'MIFG TAF weather decision',
    )

    s = replace_once(
        s,
        "function sigwx(z){let w=wx(z);return /FZ|TS|(^|\\s)[+]?RA|[+]?SN|SHRA|SHSN|FG/.test(w)&&!/^-(RA|SN|DZ)$/.test(w)}",
        "function sigwx(z){let w=wx(z);return /MIFG|FZ|TS|(^|\\s)[+]?RA|[+]?SN|SHRA|SHSN|FG/.test(w)&&!/^-(RA|SN|DZ)$/.test(w)}",
        'MIFG significant weather',
    )

    s = replace_once(
        s,
        "<td>${Math.round(z.fogRisk||0)}%</td><td>${upstreamText(z)}</td>",
        "<td>FG ${Math.round(z.fogRisk||0)}% · MIFG ${fin(z.mifgRisk)?Math.round(z.mifgRisk)+'/100':'—'}</td><td>${upstreamText(z)}</td>",
        'MIFG hourly display',
    )

    s = replace_once(
        s,
        "<span class=\"pill ok\">multimodel ✓</span><span class=\"pill ${neighbors?'ok':'warn'}\">TAF IMGW live ${Object.keys(neighborParsed).length?Object.keys(neighborParsed).length+'/3 ✓':'×'}</span><span class=\"pill ok\">Cloud Learning ✓</span>",
        "<span class=\"pill ok\">multimodel ✓</span><span class=\"pill ${rows.some(z=>fin(z.mifgRisk))?'ok':'warn'}\">MIFG engine ${rows.some(z=>fin(z.mifgRisk))?'✓':'×'}</span><span class=\"pill ${neighbors?'ok':'warn'}\">TAF IMGW live ${Object.keys(neighborParsed).length?Object.keys(neighborParsed).length+'/3 ✓':'×'}</span><span class=\"pill ok\">Cloud Learning ✓</span>",
        'MIFG source badge',
    )

    if 'PrognozaEPIRMIFG' not in s or "return'MIFG'" not in s or 'MIFG ${fin(z.mifgRisk)' not in s:
        raise SystemExit('TAF MIFG integration incomplete')

    path.write_text(s, encoding='utf-8')


def patch_verifier(path: Path) -> None:
    s = path.read_text(encoding='utf-8')

    s = replace_once(
        s,
        "    if(/\\bFG\\b/.test(s))return'FG';",
        "    if(/\\bMIFG\\b/.test(s))return'MIFG';\n    if(/\\bFG\\b/.test(s))return'FG';",
        'verification MIFG family',
    )

    s = replace_once(
        s,
        "(?:FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)",
        "(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)",
        'verification MIFG parser',
    )

    if "return'MIFG'" not in s or '(?:MIFG|FZFG|FG|' not in s:
        raise SystemExit('TAF verifier MIFG integration incomplete')

    path.write_text(s, encoding='utf-8')


if __name__ == '__main__':
    patch_taf_page(Path('taf.html'))
    patch_verifier(Path('taf-verification.js'))
    print('TAF MIFG integration: OK')
