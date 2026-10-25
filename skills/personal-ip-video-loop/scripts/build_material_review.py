#!/usr/bin/env python3
"""Render a local, immutable material-review page. No network or approval mutations."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
from urllib.parse import quote, urlsplit

KINDS = {'real': '真实素材', 'ai': 'AI 素材', 'mixed': '混合素材', 'sound': '声音'}
CSS = '''*{box-sizing:border-box}body{margin:0;background:#e9e2d5;color:#262626;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1140px;margin:auto;padding:48px 28px 80px}header{border-bottom:3px solid #245b96;padding-bottom:28px}h1{font-size:42px;line-height:1.25;margin:12px 0}h2{font-size:28px;margin-top:44px}h3{font-size:24px;line-height:1.4;margin:12px 0}a{color:#245b96;overflow-wrap:anywhere}.eyebrow,.badge{color:#245b96}.eyebrow{letter-spacing:2px;font-weight:700}.lead{font-size:20px;max-width:900px}.badge{display:inline-block;border:1px solid #245b96;border-radius:24px;padding:2px 12px;font-size:13px;margin-right:8px}.jump{display:flex;flex-wrap:wrap;gap:20px;margin-top:24px}.card{background:#faf7f0;border:1px solid #d0c7b7;box-shadow:3px 4px 0 #d5cbbc;padding:26px;margin:24px 0}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px}figure{margin:12px 0;min-width:0}video,img{width:100%;max-height:520px;object-fit:contain;background:#ede9e0;display:block}audio{width:100%}figcaption,.meta{font-size:14px;color:#64605a}blockquote{margin:20px 0;padding-left:16px;border-left:3px solid #d98c39}dl{display:grid;grid-template-columns:minmax(100px,180px) 1fr;gap:10px 20px}dt{color:#64605a}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace}summary{cursor:pointer;color:#245b96}.gap{padding:14px 20px;background:#fff3dc;border-left:3px solid #d98c39;margin:14px 0}.empty{padding:36px;text-align:center;background:#eee9df;color:#666}section,article{scroll-margin-top:20px}footer{border-top:1px solid #cfc3b2;padding-top:24px;margin-top:40px}@media(max-width:650px){main{padding:24px 16px 48px}h1{font-size:31px}h3{font-size:22px}.card{padding:18px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:12px}}'''

def esc(value):
    return html.escape(str(value), quote=True)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def value_html(value):
    if isinstance(value, (dict, list)):
        return '<pre>' + esc(json.dumps(value, ensure_ascii=False, indent=2)) + '</pre>'
    return esc(value)

def facts_html(facts):
    return '<dl>' + ''.join('<dt>'+esc(k)+'</dt><dd>'+value_html(v)+'</dd>' for k,v in facts.items()) + '</dl>'

def build(manifest, root, output):
    manifest, root, output = Path(manifest).resolve(), Path(root).resolve(), Path(output).resolve()
    if not output.is_relative_to(root):
        raise ValueError('Output must be inside media root')
    receipt = output.with_suffix('.receipt.json')
    if output.exists() or receipt.exists():
        raise ValueError('Review snapshot exists; choose a new output version')
    data = json.loads(manifest.read_text())
    media_receipts, ids, sections = [], set(), {k: [] for k in KINDS}
    for item in data['items']:
        key, kind = item['id'], item['kind']
        if not re.fullmatch(r'[A-Za-z0-9_-]+', key) or key in ids:
            raise ValueError('Item IDs must be unique safe anchors')
        if kind not in KINDS:
            raise ValueError('Unsupported item kind: '+kind)
        ids.add(key)
        clips = []
        for media in item.get('media', []):
            rel = Path(media['path'])
            path = (root / rel).resolve()
            if rel.is_absolute() or not path.is_relative_to(root) or not path.is_file():
                raise ValueError('Missing or out-of-root media: '+str(rel))
            sha = digest(path)
            if media.get('sha256') and sha != media['sha256']:
                raise ValueError('Media hash mismatch: '+str(rel))
            src = esc(quote(os.path.relpath(path, output.parent), safe='/'))
            typ = media['type']
            if typ == 'image':
                tag = f'<img src="{src}" alt="{esc(media.get("label",key))}" loading="lazy">'
            elif typ == 'video':
                tag = f'<video src="{src}" controls muted playsinline preload="metadata"></video>'
            elif typ == 'audio':
                tag = f'<audio src="{src}" controls preload="none"></audio>'
            else:
                raise ValueError('Unsupported media type: '+typ)
            clips.append('<figure>'+tag+'<figcaption>'+esc(media.get('label',''))+'</figcaption></figure>')
            media_receipts.append({'item':key,'path':str(rel),'sha256':sha})
        links = []
        for link in item.get('links', []):
            url = link['url']; parsed = urlsplit(url)
            if parsed.scheme not in ('https','http') or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError('Source link must be an HTTP(S) URL without credentials')
            links.append(f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{esc(link["label"])}</a>')
        card = f'<article class="card" id="{key}"><span class="badge">{esc(KINDS[kind])}</span><span class="badge">{esc(item["status"])}</span><h3>{esc(key)} · {esc(item["title"])}</h3>'
        card += '<p class="meta">'+esc(item.get('timing','待匹配时间线'))+'</p>'
        if item.get('quote'): card += '<blockquote>'+esc(item['quote'])+'</blockquote>'
        card += '<p>'+esc(item.get('purpose',''))+'</p>'
        card += '<div class="media-grid">'+(''.join(clips) if clips else '<div class="empty">素材待补 · '+esc(item.get('missing','尚无可预览文件'))+'</div>')+'</div>'
        card += facts_html(item.get('facts', {}))
        if item.get('prompt'): card += '<details><summary>查看完整生成提示词</summary><pre>'+esc(item['prompt'])+'</pre></details>'
        card += '<p>'+' · '.join(links)+'</p></article>'
        sections[kind].append(card)
    doc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(data['title'])+'</title><style>'+CSS+'</style></head><body><main>'
    doc += '<header><div class="eyebrow">素材审阅 / '+esc(data.get('version',''))+'</div><h1>'+esc(data['title'])+'</h1><p class="lead">'+esc(data.get('intro',''))+'</p>'+facts_html(data.get('summary',{}))
    doc += '<nav class="jump">'+''.join(f'<a href="#{k}">{v}</a>' for k,v in KINDS.items() if sections[k])+'<a href="#gaps">剩余差距</a></nav></header>'
    for kind, cards in sections.items():
        if cards: doc += f'<section id="{kind}"><h2>{KINDS[kind]}</h2>'+''.join(cards)+'</section>'
    doc += '<section id="gaps"><h2>剩余差距</h2>'+''.join('<div class="gap">'+esc(g)+'</div>' for g in data.get('gaps',[]))+'</section><footer>'
    doc += ''.join('<p class="meta">'+esc(n)+'</p>' for n in data.get('notes',[]))
    doc += '<p class="meta">页面用于预览与核对；批准以对应版本的真实用户回复及记录为准。</p></footer></main></body></html>'
    evidence = {'manifest':str(manifest),'manifest_sha256':digest(manifest),'media':media_receipts,'html_sha256':hashlib.sha256(doc.encode()).hexdigest(),'approval_created':False}
    output.parent.mkdir(parents=True,exist_ok=True)
    # Exclusive create also protects snapshots if another process races the checks.
    with output.open('x') as f: f.write(doc)
    with receipt.open('x') as f: json.dump(evidence,f,ensure_ascii=False,indent=2)
    return evidence

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('manifest');p.add_argument('--root',required=True);p.add_argument('--output',required=True)
    a=p.parse_args()
    try:
        result=build(a.manifest,a.root,a.output)
    except (ValueError,KeyError,OSError) as exc:
        p.exit(1,str(exc)+'\n')
    print(json.dumps({'output':a.output,'media_checked':len(result['media']),'approval_created':False},ensure_ascii=False))
