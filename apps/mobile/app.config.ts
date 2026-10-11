// Конфигурация сборки. Значения по умолчанию — для тестовой сборки P0.
// API_URL можно задать при сборке (EXPO_PUBLIC_API_URL) и поменять в приложении на экране «Моё».
import type { ExpoConfig } from 'expo/config';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID ?? 'app.blizkie.p0';
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE ?? 'app.blizkie.p0';
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID;

const LOCATION_WHEN_IN_USE =
  '«Близкие» показывают вашу точку выбранному человеку, только когда вы сами включили обмен. Точность и время измерения видны на карте.';
const LOCATION_ALWAYS =
  'Чтобы точка обновлялась, когда приложение свёрнуто или экран заблокирован, нужен доступ «Всегда». Обмен можно остановить в любой момент кнопкой «Остановить».';

const config: ExpoConfig = {
  // Латиница: из имени генерируются имена Xcode-проекта и схемы; кириллица ломает сборку iOS
  name: 'Blizkie P0',
  slug: 'blizkie-p0',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: IOS_BUNDLE_ID,
    buildNumber: '1',
    supportsTablet: false,
    infoPlist: {
      // Только location; push/remote-notification добавим на этапе D после настройки APNs
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // Android 13+: видимое уведомление foreground service о передаче геолокации
    permissions: ['android.permission.POST_NOTIFICATIONS'],
    // Явно запрещаем то, что не нужно P0
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW'],
  },
  plugins: [
    [
      'expo-location',
      {
        locationWhenInUsePermission: LOCATION_WHEN_IN_USE,
        locationAlwaysAndWhenInUsePermission: LOCATION_ALWAYS,
        locationAlwaysPermission: LOCATION_ALWAYS,
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
  ],
  extra: {
    apiUrl: API_URL,
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
};

export default config;
