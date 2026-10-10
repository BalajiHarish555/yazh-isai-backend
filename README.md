# YZH Music Intelligence Platform

A production-ready music intelligence platform combining a NestJS backend with a React/Vite frontend.

## Project Structure

```
.
├── yzh-backend-pro/          # Backend (NestJS)
│   ├── src/                  # Source code
│   ├── prisma/               # Prisma schema and seed
│   ├── Dockerfile            # Multi-stage Docker build
│   ├── docker-compose.yml    # Docker Compose configuration
│   ├── package.json          # Backend dependencies
│   └── ... 
└── ../yzh/                   # Frontend (React/Vite)
    ├── src/                  # Source code
    ├── public/               # Static assets
    ├── package.json          # Frontend dependencies
    └── ...
```

## Production Deployment

### Using Docker (Recommended)

1. Ensure you have Docker and Docker Compose installed
2. Place the `yzh` frontend directory as a sibling to `yzh-backend-pro`:
   ```
   parent-directory/
   ├── yzh-backend-pro/
   └── yzh/
   ```
3. Build and start the services:
   ```bash
   cd yzh-backend-pro
   docker-compose up --build
   ```
4. The application will be available at:
   - Frontend: http://localhost:5000
   - API: http://localhost:5000/api/v1

### Manual Deployment

1. **Backend Setup**
   ```bash
   cd yzh-backend-pro
   npm install
   npx prisma generate
   npx prisma migrate deploy
   npm run build
   ```

2. **Frontend Setup**
   ```bash
   cd ../yzh
   npm install
   npm run build
   ```

3. **Deploy**
   ```bash
   cd ../yzh-backend-pro
   # Copy frontend build to backend public directory
   cp -r ../yzh/dist ./public
   # Start the server
   npm start
   ```

## Environment Variables

Create a `.env` file in the backend root:

```env
PORT=5000
DATABASE_URL=postgresql://user:password@localhost:5432/yzh_music?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
```

## API Documentation

Once running, visit http://localhost:5000/api/v1 for Swagger API documentation.

## Default Admin Credentials

- Email: admin@example.com
- Password: admin123

⚠️ **Change these credentials immediately after first login in production!**

## Features

- Music intelligence attributes (energy, valence, danceability, etc.)
- User authentication and authorization
- Playlist management
- Artist and album catalog
- Listening history tracking
- Recommendation engine
- Caching layer with Redis
- RESTful API with OpenAPI/Swagger documentation
- Responsive React/Vite frontend with Tailwind CSS

## Database Schema

See `prisma/schema.prisma` for the complete database schema including:
- Users, Profiles, Preferences
- Artists, Albums, Tracks
- Playlists, Liked content, Followed artists
- Listening events and music intelligence attributes

## License

ISC