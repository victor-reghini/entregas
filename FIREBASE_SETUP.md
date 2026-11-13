# Guia de Configuração do Firebase — Rotas SPX Express

Este app já está **100% pronto** para funcionar localmente e também integrado ao Firebase (Autenticação + Banco Firestore para histórico de rotas diárias).

Você pode conectar o Firebase de duas maneiras:
1. **Pela interface do app (mais fácil):** Clicando no ícone de engrenagem no cabeçalho.
2. **Direto no código:** Editando o arquivo `js/firebase-service.js`.

---

## Variáveis de Ambiente (.env e Netlify)

Por motivos de segurança e para evitar vazamento em repositórios Git, todas as credenciais do Firebase ficam protegidas em variáveis de ambiente.

### No Netlify (Ambiente de Produção)
Acesse o painel do seu site no Netlify:
1. Vá em **Site configuration > Environment variables**.
2. Clique em **Add a variable** e adicione:

| Variável | Descrição |
|---|---|
| `FIREBASE_API_KEY` | Chave de API do Firebase |
| `FIREBASE_AUTH_DOMAIN` | Domínio de Auth (`*.firebaseapp.com`) |
| `FIREBASE_PROJECT_ID` | ID do projeto |
| `FIREBASE_STORAGE_BUCKET` | Bucket de armazenamento |
| `FIREBASE_MESSAGING_SENDER_ID` | ID do remetente de mensagens |
| `FIREBASE_APP_ID` | ID do aplicativo web |
| `TEST_USER_EMAIL` | (Opcional) E-mail para testes |
| `TEST_USER_PASSWORD` | (Opcional) Senha para testes |

No momento do build, o Netlify executa automaticamente o script `node scripts/inject-env.js`, que injeta essas variáveis de forma segura no app.

---

### Localmente (Ambiente de Desenvolvimento)
1. O arquivo `.env` já contém suas chaves configuradas na sua máquina.
2. O arquivo `.env` está devidamente listado no `.gitignore` para nunca ser enviado ao GitHub.
3. Use o template `.env.example` como referência.

---

### 2. Ativar Autenticação (Authentication)
1. No menu lateral esquerdo, vá em **Criação > Authentication**.
2. Clique em **Começar**.
3. Na aba **Método de login** (Sign-in method):
   - Ative **E-mail/senha** e salve.
   - (Opcional) Ative **Google** se desejar login com um toque.

---

### 3. Ativar o Banco de Dados (Cloud Firestore)
1. No menu lateral esquerdo, vá em **Criação > Firestore Database**.
2. Clique em **Criar banco de dados**.
3. Selecione a localização (ex: `southamerica-east1` para São Paulo / Brasil).
4. Em regras de segurança, inicie em **Modo de teste** (ou use as regras abaixo para proteger por usuário).

#### Regras recomendadas para o Firestore:
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

---

### 4. Obter as Chaves do SDK Web
1. Vá nas **Configurações do Projeto** (ícone de engrenagem no topo do menu lateral).
2. Na aba **Geral**, desça até a seção **Seus aplicativos** e clique no ícone **`</>` (Web)**.
3. Dê um apelido (ex: `spx-web`) e clique em **Registrar app**.
4. Copie o objeto `firebaseConfig` exibido:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef..."
};
```

---

### 5. Integrar no App

#### Opção A (Pela Interface do App):
1. Abra o site/app.
2. Clique no ícone de **Engrenagem** no cabeçalho superior direito.
3. Cole as chaves nos campos e clique em **"Salvar e Inicializar Firebase"**.

#### Opção B (No Código):
Abra o arquivo `js/firebase-service.js` e preencha o objeto `DEFAULT_CONFIG` no topo:
```javascript
const DEFAULT_CONFIG = {
  apiKey: "SUA_API_KEY",
  authDomain: "SEU_AUTH_DOMAIN",
  projectId: "SEU_PROJECT_ID",
  storageBucket: "SEU_STORAGE_BUCKET",
  messagingSenderId: "SEU_MESSAGING_SENDER_ID",
  appId: "SEU_APP_ID"
};
```

Pronto! Assim que configurado, o app sincronizará automaticamente todas as rotas concluídas e logins na nuvem.
