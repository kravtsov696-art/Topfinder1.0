// Карта на Leaflet + OpenStreetMap внутри WebView: не нужен ключ Google Maps.
// Никакой анимации «живой» точки: устаревшая точка рисуется серой и пунктиром.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

export interface MapPoint {
  id: 'me' | 'peer';
  lat: number;
  lon: number;
  accuracyM: number;
  color: string;
  dashed: boolean;
  label: string;
}

const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#m{height:100%;margin:0;background:#e9ecef}.lbl{background:#fff;border:1px solid #999;border-radius:4px;padding:1px 4px;font:12px sans-serif;white-space:nowrap}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var ok = typeof L !== 'undefined';
function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
if(!ok){ post({type:'error', message:'Leaflet не загрузился (нет сети?)'}); }
else {
  var map = L.map('m', {zoomControl:true}).setView([45.04, 38.97], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '&copy; OpenStreetMap'}).addTo(map);
  var layers = {}; var fitted = false;
  window.setPoints = function(points, fit){
    Object.keys(layers).forEach(function(k){ map.removeLayer(layers[k]); }); layers = {};
    var bounds = [];
    points.forEach(function(p){
      var g = L.layerGroup();
      L.circle([p.lat, p.lon], {radius: p.accuracyM, color: p.color, weight: 1, fillOpacity: 0.12, dashArray: p.dashed ? '6 6' : null}).addTo(g);
      L.circleMarker([p.lat, p.lon], {radius: 7, color: '#fff', weight: 2, fillColor: p.color, fillOpacity: 1}).addTo(g)
        .bindTooltip(p.label, {permanent: true, direction: 'top', className: 'lbl', offset: [0, -8]});
      g.addTo(map); layers[p.id] = g; bounds.push([p.lat, p.lon]);
    });
    if ((fit || !fitted) && bounds.length) {
      fitted = true;
      if (bounds.length === 1) map.setView(bounds[0], 16); else map.fitBounds(bounds, {padding: [40, 40], maxZoom: 17});
    }
  };
  post({type:'ready'});
}
</script></body></html>`;

export default function MapView({ points, fitKey }: { points: MapPoint[]; fitKey: number }) {
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFit = useRef(-1);

  useEffect(() => {
    if (!ready) return;
    const fit = fitKey !== lastFit.current;
    lastFit.current = fitKey;
    ref.current?.injectJavaScript(`window.setPoints && window.setPoints(${JSON.stringify(points)}, ${fit}); true;`);
  }, [points, ready, fitKey]);

  return (
    <View style={st.wrap}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html: HTML, baseUrl: 'https://localhost/' }}
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data) as { type: string; message?: string };
            if (m.type === 'ready') setReady(true);
            if (m.type === 'error') setError(m.message ?? 'ошибка карты');
          } catch {
            /* ignore */
          }
        }}
        onError={(e) => setError(e.nativeEvent.description)}
        javaScriptEnabled
        style={st.web}
      />
      {error ? <Text style={st.err}>Карта недоступна: {error}. Координаты и статусы — в блоке ниже.</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { height: 320, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: '#D8DDE3', marginBottom: 10 },
  web: { flex: 1 },
  err: { position: 'absolute', left: 8, right: 8, bottom: 8, backgroundColor: '#fff', padding: 6, color: '#C92A2A', fontSize: 12 },
});
