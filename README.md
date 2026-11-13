# Organiza Entregas 📦🚚

> Aplicativo Web Progressivo (PWA) Mobile-First para Roteirização Inteligente, Organização de Cargas e Execução de Entregas com Suporte 100% Offline.

---

## 🚀 Principais Funcionalidades

- **📱 Instalável no Celular (PWA Offline-First)**:
  - Pode ser instalado diretamente na tela inicial no Android e iOS como um app nativo.
  - Todas as dependências (Leaflet, SheetJS, HTML5-QRCode, Firebase) estão salvas localmente em `vendor/` e pré-cacheadas pelo Service Worker (`sw.js`).
  - Funciona plenamente sem conexão com a internet durante toda a rota de entrega.

- **📊 Importação e Otimização de Rotas**:
  - Aceita planilhas `.xlsx`, `.xls` ou `.csv` (como relatórios de romaneio SPX / Shopee Express).
  - Agrupa múltiplos pacotes no mesmo endereço e calcula a melhor sequência rua por rua sem zigue-zague.

- **📷 Organização de Pacotes por Câmera (QR Code & Código de Barras)**:
  - Bipagem rápida antes de carregar o veículo para identificar imediatamente o número da parada e a ordem no porta-malas.
  - **Modal de Confirmação**: Ao escanear com sucesso, abre um modal com o número da parada, endereço e código de rastreio. O botão **"OK (Escanear Próximo)"** ou fechar retoma a câmera instantaneamente.

- **🗺️ Mapa Interativo com Trajeto & Rota Animada**:
  - Visualização de **todas as paradas** no mapa com pins numerados e diferenciados por cor de status (pendente, entregue, falha).
  - Destaque pulsante na **parada atual**.
  - **Animação de percurso**: veículo percorrendo suavemente todo o trajeto da rota.
  - Controles de centralização e ajuste geral de enquadramento.

- **✅ Modo Entregador Passo a Passo**:
  - Cartão de endereço com botões rápidos de GPS para Google Maps e Waze.
  - Suporte a trechos em lotes de 10 paradas (Android Auto).
  - Checklist por pacote com marcação de status (Entregue / Pendente / Falha com motivo).
  - Geolocalização inteligente com detecção automática de proximidade do endereço.

- **☁️ Sincronização em Nuvem (Firebase)**:
  - Conexão opcional com Firebase Auth e Cloud Firestore.
  - Histórico de rotas concluídas com armazenamento em nuvem e fallback local no `localStorage`.

- **📈 Relatório Final**:
  - Resumo de taxa de sucesso e pacotes não entregues.
  - Exportação dos dados em planilha `.csv` e botão de cópia de resumo da rota.

---

## 📂 Estrutura do Projeto

```text
├── index.html                 # Interface SPA mobile-first
├── manifest.json              # Manifesto PWA com metadados e ícones
├── sw.js                      # Service Worker para cache e modo offline
├── netlify.toml               # Configurações de deploy e headers de cache
├── README.md                  # Documentação completa do projeto
│
├── css/
│   └── style.css              # Estilos responsivos, temas Dark/Light e animações
│
├── js/
│   ├── app.js                 # Controlador principal, UI, eventos e ciclo de vida
│   ├── optimizer.js           # Algoritmo de roteirização e agrupamento por endereço
│   ├── scanner.js             # Scanner com câmera e controle de pausa/retomada
│   ├── firebase-service.js    # Camada de autenticação e banco Firestore/Offline
│   ├── icons.js               # Biblioteca de ícones SVG leves
│   └── env.js                 # Variáveis de ambiente geradas para o cliente
│
├── vendor/                    # Dependências locais cacheadas offline
│   ├── leaflet.css / .js      # Mapas interativos (Leaflet)
│   ├── xlsx.full.min.js       # Leitura de planilhas Excel (SheetJS)
│   ├── html5-qrcode.min.js    # Leitor de QR Code e código de barras
│   ├── firebase-*-compat.js   # SDKs do Firebase (App, Auth, Firestore)
│   └── images/                # Marcadores de mapa
│
├── icons/                     # Ícones do app para instalação PWA
│   ├── icon-192.png           # Ícone 192x192
│   ├── icon-512.png           # Ícone 512x512
│   ├── icon-maskable-*.png    # Ícones com área de respiro adaptativa
│   ├── icon.svg               # Vetor base do app
│   └── favicon.ico            # Favicon para navegadores desktop
│
└── scripts/
    └── inject-env.js          # Injeta variáveis do .env/Netlify em js/env.js
```

---

## 🛠️ Como Executar Localmente

Como o projeto é construído em JavaScript puro sem necessidade de build steps complexos:

1. **Clone ou acerte os arquivos**:
   ```bash
   cd entregas
   ```

2. **Inicie qualquer servidor web local**:
   - Com Python 3:
     ```bash
     python3 -m http.server 8080
     ```
   - Com Node.js (`npx serve`):
     ```bash
     npx serve .
     ```

3. **Acesse no navegador**:
   Abra `http://localhost:8080` (ou o IP local da sua máquina para testar direto no celular na mesma rede Wi-Fi).

---

## 📲 Como Instalar no Celular

### Android (Google Chrome / Brave / Edge)
1. Acesse o endereço do app.
2. Toque no botão **"Instalar"** no cabeçalho ou abra o menu do navegador (3 pontinhos) e toque em **"Adicionar à tela inicial"** / **"Instalar aplicativo"**.

### iOS (Safari)
1. Acesse o endereço do app no Safari.
2. Toque no botão de **Compartilhar** (ícone de quadrado com seta para cima).
3. Role para baixo e selecione **"Adicionar à Tela de Início"**.

---

## 🔒 Variáveis de Ambiente & Firebase

As credenciais do Firebase são mantidas no arquivo `.env` local e configuradas como variáveis de ambiente no serviço de hospedagem (Netlify). Para regerar o arquivo `js/env.js`:

```bash
node scripts/inject-env.js
```

### Regras de Segurança do Firestore
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/routes/{routeId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```


