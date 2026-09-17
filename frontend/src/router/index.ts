import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import WaitingRoomView from '../views/WaitingRoomView.vue';
import MeetingRoomView from '../views/MeetingRoomView.vue';
import DashboardView from '../views/DashboardView.vue';

const routes = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/waiting/:roomId', name: 'waiting', component: WaitingRoomView },
  { path: '/room/:roomId', name: 'room', component: MeetingRoomView },
  { path: '/dashboard', name: 'dashboard', component: DashboardView }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});
