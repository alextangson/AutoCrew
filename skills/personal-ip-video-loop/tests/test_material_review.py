import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from html.parser import HTMLParser

spec=importlib.util.spec_from_file_location('review',Path(__file__).parents[1]/'scripts/build_material_review.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Tags(HTMLParser):
    def __init__(self,text):
        super().__init__();self.tags=[];self.feed(text)
    def handle_starttag(self,tag,attrs):self.tags.append((tag,dict(attrs)))

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'media').mkdir()
        (self.root/'media/test clip.mp4').write_bytes(b'fixture-media')
        self.data={'title':'<script>bad</script>','items':[{'id':'S01','kind':'real','title':'示例','status':'待审','media':[{'type':'video','path':'media/test clip.mp4'}],'links':[]}],'gaps':['待补']}
    def render(self):
        p=self.root/'display.json';p.write_text(json.dumps(self.data));return m.build(p,self.root,self.root/'v1/review.html')
    def test_playable_relative_and_escaped(self):
        r=self.render();doc=(self.root/'v1/review.html').read_text();tags=Tags(doc).tags
        self.assertNotIn('script',[t for t,a in tags]);v=[a for t,a in tags if t=='video'][0]
        self.assertEqual(v['src'],'../media/test%20clip.mp4');self.assertIn('controls',v);self.assertNotIn('autoplay',v)
        self.assertFalse(r['approval_created']);self.assertEqual(len(r['media']),1)
    def test_snapshot_cannot_be_overwritten(self):
        self.render();old=(self.root/'v1/review.html').read_bytes()
        with self.assertRaises(ValueError):self.render()
        self.assertEqual(old,(self.root/'v1/review.html').read_bytes())
    def test_missing_and_hash_mismatch(self):
        self.data['items'][0]['media'][0]['sha256']='wrong'
        with self.assertRaises(ValueError):self.render()
        self.data['items'][0]['media'][0]={'type':'image','path':'missing.png'}
        with self.assertRaises(ValueError):self.render()
    def test_traversal_and_symlink(self):
        self.data['items'][0]['media'][0]['path']='../outside.png'
        with self.assertRaises(ValueError):self.render()
        (self.root/'media/outside').symlink_to('/etc/hosts')
        self.data['items'][0]['media'][0]['path']='media/outside'
        with self.assertRaises(ValueError):self.render()
    def test_unsafe_link(self):
        self.data['items'][0]['links']=[{'label':'来源','url':'javascript:alert(1)'}]
        with self.assertRaises(ValueError):self.render()
    def test_all_routes_and_empty_candidate(self):
        self.data['items']=[{'id':k,'kind':k,'title':k,'status':'待补','media':[]} for k in m.KINDS]
        self.render();tags=Tags((self.root/'v1/review.html').read_text()).tags
        anchors={a.get('id') for t,a in tags}
        self.assertTrue(set(m.KINDS)|{'gaps'} <= anchors)

if __name__=='__main__':unittest.main()
