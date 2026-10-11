import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import * as api from '../api';
import { logEvent } from '../diag';
import { applyMode } from '../location';
import { getSettings, updateSettings } from '../storage';
import { Btn, Card, Note, Row, colors, fmtDateTime } from '../ui';

export default function PairScreen() {
  const [pairs, setPairs] = useState<api.PairView[]>([]);
  const [invite, setInvite] = useState<{ codePretty: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<{ inviterName: string; inviterPlatform: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const reload = useCallback(async () => {
    try {
      const r = await api.listPairs();
      setPairs(r.pairs);
      setError(null);
      const s = await getSettings();
      const active = r.pairs.find((p) => p.active);
      if (active && s.activePairId !== active.pairId && !r.pairs.find((p) => p.pairId === s.activePairId && p.active)) {
        await updateSettings({ activePairId: active.pairId });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => {
      setTick((x) => x + 1);
      void reload();
    }, 5000);
    return () => clearInterval(t);
  }, [reload]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Не получилось', (e as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  }

  const inviteLeft = invite ? Math.max(0, Math.round((invite.expiresAt - api.serverNow()) / 1000)) : 0;

  return (
    <ScrollView contentContainerStyle={st.pad}>
      <Card title="Пригласить второй телефон">
        <Note>Покажите код владельцу второго телефона. Код одноразовый и действует 10 минут. Связь появится только после его подтверждения.</Note>
        {invite && inviteLeft > 0 ? (
          <>
            <Text style={st.code} selectable>
              {invite.codePretty}
            </Text>
            <Note>Действует ещё {Math.floor(inviteLeft / 60)}:{String(inviteLeft % 60).padStart(2, '0')}</Note>
          </>
        ) : null}
        <Btn
          title={invite ? 'Новый код' : 'Получить код'}
          busy={busy === 'invite'}
          onPress={() =>
            run('invite', async () => {
              const r = await api.createInvite();
              setInvite(r);
              void logEvent('pair', { action: 'invite_created' });
            })
          }
        />
      </Card>

      <Card title="Ввести код с другого телефона">
        <TextInput
          style={st.input}
          value={code}
          onChangeText={(v) => {
            setCode(v);
            setPreview(null);
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="XXXX-XXXX"
          maxLength={9}
        />
        {!preview ? (
          <Btn
            title="Проверить код"
            busy={busy === 'preview'}
            disabled={code.replace(/[^0-9a-z]/gi, '').length !== 8}
            onPress={() => run('preview', async () => setPreview(await api.previewInvite(code)))}
          />
        ) : (
          <>
            <Note color={colors.text}>
              Телефон «{preview.inviterName}» ({preview.inviterPlatform}) предлагает связь. После подтверждения вы оба сможете включать обмен
              координатами друг с другом. Сам обмен пока останется выключенным.
            </Note>
            <Btn
              title="Подтверждаю связь"
              busy={busy === 'accept'}
              onPress={() =>
                run('accept', async () => {
                  const r = await api.acceptInvite(code);
                  await updateSettings({ activePairId: r.pairId });
                  setCode('');
                  setPreview(null);
                  void logEvent('pair', { action: 'accepted' });
                  Alert.alert('Связь создана', `С «${r.peerName}». Обмен выключен, пока вы его не включите.`);
                })
              }
            />
            <Btn title="Отмена" kind="plain" onPress={() => setPreview(null)} />
          </>
        )}
      </Card>

      {error ? <Note color={colors.danger}>Сервер: {error}</Note> : null}

      {pairs.map((p) => (
        <Card key={p.pairId} title={`Связь с «${p.peerName}»`}>
          <Row label="Состояние" value={p.active ? 'активна' : p.revokedAt ? `разорвана ${fmtDateTime(p.revokedAt)}` : 'истекла'} color={p.active ? colors.ok : colors.danger} />
          <Row label="Я показываю свою точку" value={p.iShare ? 'да' : 'нет'} color={p.iShare ? colors.warn : undefined} />
          <Row label="Мне показывают точку" value={p.peerShares ? 'да' : 'нет'} />
          <Row label="Платформа собеседника" value={p.peerPlatform} />
          <Row label="Связь действует до" value={fmtDateTime(p.expiresAt)} />
          {p.active ? (
            <>
              {!p.iShare ? (
                <Btn
                  title="Включить обмен"
                  busy={busy === `on-${p.pairId}`}
                  onPress={() =>
                    run(`on-${p.pairId}`, async () => {
                      const s = await getSettings();
                      if (s.mode === 'OFF') {
                        const r = await applyMode('ECO');
                        if (!r.ok) throw new Error(r.reason + '\n\nОткройте вкладку «Моё» и разрешите геолокацию.');
                      }
                      await api.setSharing(p.pairId, true);
                      await updateSettings({ activePairId: p.pairId });
                      void logEvent('pair', { action: 'sharing_on' });
                    })
                  }
                />
              ) : (
                <Btn
                  title="Остановить (перестать показывать мою точку)"
                  kind="danger"
                  busy={busy === `off-${p.pairId}`}
                  onPress={() =>
                    run(`off-${p.pairId}`, async () => {
                      await api.setSharing(p.pairId, false);
                      // P0: одна связь — останавливаем и системные обновления
                      const others = pairs.filter((x) => x.pairId !== p.pairId && x.active && x.iShare);
                      if (others.length === 0) await applyMode('OFF');
                      void logEvent('pair', { action: 'sharing_off' });
                    })
                  }
                />
              )}
              <Btn
                title="Разорвать связь"
                kind="plain"
                onPress={() =>
                  Alert.alert('Разорвать связь?', 'Оба телефона сразу перестанут видеть координаты друг друга. Для новой связи понадобится новый код.', [
                    { text: 'Отмена' },
                    {
                      text: 'Разорвать',
                      style: 'destructive',
                      onPress: () =>
                        void run(`rev-${p.pairId}`, async () => {
                          await api.revokePair(p.pairId);
                          void logEvent('pair', { action: 'revoked' });
                          if (!pairs.some((x) => x.pairId !== p.pairId && x.active && x.iShare)) await applyMode('OFF');
                        }),
                    },
                  ])
                }
              />
            </>
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  pad: { padding: 12, paddingBottom: 40 },
  code: { fontSize: 38, fontWeight: '800', letterSpacing: 4, textAlign: 'center', marginVertical: 10, color: colors.text, fontVariant: ['tabular-nums'] },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, fontSize: 22, letterSpacing: 3, textAlign: 'center', backgroundColor: '#fff', color: colors.text },
});
