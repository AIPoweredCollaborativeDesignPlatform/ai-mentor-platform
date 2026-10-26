import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import WaitingRoomView from '../views/WaitingRoomView.vue';
import MeetingRoomView from '../views/MeetingRoomView.vue';
import DashboardView from '../views/DashboardView.vue';

// Study administration (lazy: only researchers load it)
const AdminView = () => import('../views/AdminView.vue');

const routes = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/waiting/:roomId', name: 'waiting', component: WaitingRoomView },
  { path: '/room/:roomId', name: 'room', component: MeetingRoomView },
  { path: '/dashboard', name: 'dashboard', component: DashboardView },
  { path: '/admin', name: 'admin', component: AdminView }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});
