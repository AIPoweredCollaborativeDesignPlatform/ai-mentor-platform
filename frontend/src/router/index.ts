import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import WaitingRoomView from '../views/WaitingRoomView.vue';
import MeetingRoomView from '../views/MeetingRoomView.vue';
import DashboardView from '../views/DashboardView.vue';

// Study administration (lazy: only researchers load it)
const AdminView = () => import('../views/AdminView.vue');
const ReplayView = () => import('../views/ReplayView.vue');

const routes = [
  { path: '/admin/coding', name: 'coding', component: () => import('../views/CodingView.vue') },
  { path: '/', name: 'home', component: HomeView },
  { path: '/waiting/:roomId', name: 'waiting', component: WaitingRoomView },
  { path: '/room/:roomId', name: 'room', component: MeetingRoomView },
  { path: '/dashboard', name: 'dashboard', component: DashboardView },
  { path: '/admin', name: 'admin', component: AdminView },
  { path: '/admin/replay/:roomId', name: 'replay', component: ReplayView }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});
