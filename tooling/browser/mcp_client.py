"""Small localhost client for the repository's Chrome DevTools MCP bridge."""
import json
import re
import urllib.parse
import urllib.request


class DevTools:
    def __init__(self, bridge='http://127.0.0.1:9338'):
        url = urllib.parse.urlparse(bridge)
        if url.scheme != 'http' or url.hostname != '127.0.0.1':
            raise ValueError('Bridge must be http://127.0.0.1:<port>')
        self.bridge = bridge.rstrip('/')

    def call(self, name, arguments=None):
        request = urllib.request.Request(self.bridge+'/call',data=json.dumps({'name':name,'arguments':arguments or {}}).encode(),
            headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=135) as response:
            result = json.load(response)
        if result.get('isError'):
            raise RuntimeError(f'Chrome DevTools MCP tool failed: {name}')
        return '\n'.join(block.get('text','') for block in result.get('content',[]) if block['type']=='text')

    def evaluate(self, source):
        raw = self.call('evaluate_script',{'function':source,'waitForStableDom':False})
        match = re.search(r'```(?:json)?\n([\s\S]*?)\n```',raw)
        if not match:
            raise ValueError('Missing JSON result from browser evaluation')
        return json.loads(match[1])

    def uid(self, pattern):
        for line in self.call('take_snapshot').splitlines():
            if re.search(pattern,line):
                match = re.search(r'uid=(\S+)',line)
                if match:
                    return match[1]
        raise ValueError('Snapshot element not found: '+pattern)
