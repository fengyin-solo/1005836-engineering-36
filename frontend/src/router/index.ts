import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Pumpstation = () => import('@/views/pumpstation/index.vue')
const Pumprun = () => import('@/views/pumprun/index.vue')
const Drainpipe = () => import('@/views/drainpipe/index.vue')
const Manhole = () => import('@/views/manhole/index.vue')
const Dredge = () => import('@/views/dredge/index.vue')
const Waterlevel = () => import('@/views/waterlevel/index.vue')
const Rainfall = () => import('@/views/rainfall/index.vue')
const Waterlog = () => import('@/views/waterlog/index.vue')
const Floodgate = () => import('@/views/floodgate/index.vue')
const Pumpmaint = () => import('@/views/pumpmaint/index.vue')
const Sluice = () => import('@/views/sluice/index.vue')
const Screen = () => import('@/views/screen/index.vue')
const Outfallpatrol = () => import('@/views/outfallpatrol/index.vue')
const Floodwarn = () => import('@/views/floodwarn/index.vue')
const Rescueteam = () => import('@/views/rescueteam/index.vue')
const Drainequipment = () => import('@/views/drainequipment/index.vue')
const Cctvinspect = () => import('@/views/cctvinspect/index.vue')
const Dispatchplan = () => import('@/views/dispatchplan/index.vue')
const DispatchplanDetail = () => import('@/views/dispatchplan/detail.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/pumpstation', name: 'pumpstation', component: Pumpstation },
    { path: '/pumprun', name: 'pumprun', component: Pumprun },
    { path: '/drainpipe', name: 'drainpipe', component: Drainpipe },
    { path: '/manhole', name: 'manhole', component: Manhole },
    { path: '/dredge', name: 'dredge', component: Dredge },
    { path: '/waterlevel', name: 'waterlevel', component: Waterlevel },
    { path: '/rainfall', name: 'rainfall', component: Rainfall },
    { path: '/waterlog', name: 'waterlog', component: Waterlog },
    { path: '/floodgate', name: 'floodgate', component: Floodgate },
    { path: '/pumpmaint', name: 'pumpmaint', component: Pumpmaint },
    { path: '/sluice', name: 'sluice', component: Sluice },
    { path: '/screen', name: 'screen', component: Screen },
    { path: '/outfallpatrol', name: 'outfallpatrol', component: Outfallpatrol },
    { path: '/floodwarn', name: 'floodwarn', component: Floodwarn },
    { path: '/rescueteam', name: 'rescueteam', component: Rescueteam },
    { path: '/drainequipment', name: 'drainequipment', component: Drainequipment },
    { path: '/cctvinspect', name: 'cctvinspect', component: Cctvinspect },
    { path: '/dispatchplan', name: 'dispatchplan', component: Dispatchplan },
    { path: '/dispatchplan/:id', name: 'dispatchplan-detail', component: DispatchplanDetail },
  ],
})

export default router
