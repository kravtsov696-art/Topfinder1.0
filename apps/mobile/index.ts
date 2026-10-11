// Фоновые задачи регистрируются ПЕРВЫМИ — до интерфейса.
// Когда ОС будит приложение только ради геолокации, этот импорт гарантирует, что задача определена.
import './src/tasks';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
