import { Routes } from '@angular/router';
import { AppShellComponent } from './layout/app-shell.component';

export const routes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sprite-prep' },
      {
        path: 'sprite-prep',
        loadComponent: () =>
          import('./features/sprite-prep/sprite-prep.component').then((m) => m.SpritePrepComponent),
      },
      {
        path: 'video-gen',
        loadComponent: () =>
          import('./features/video-gen/video-gen.component').then((m) => m.VideoGenComponent),
      },
      {
        path: 'video-prep',
        loadComponent: () =>
          import('./features/video-prep/video-prep.component').then((m) => m.VideoPrepComponent),
      },
      {
        path: 'export',
        loadComponent: () =>
          import('./features/exporter/exporter.component').then((m) => m.ExporterComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings.component').then((m) => m.SettingsComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'sprite-prep' },
];
