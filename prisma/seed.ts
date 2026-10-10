// prisma/seed.ts
import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcrypt'

const prisma = new PrismaClient()

async function main() {
  const adminEmail = 'admin@example.com'
  const adminPassword = 'admin123'
  const hashedPassword = await bcrypt.hash(adminPassword, 10)

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      username: 'admin',
      passwordHash: hashedPassword,
      role: 'ADMIN',
      isActive: true,
      profile: {
        create: {
          displayName: 'Admin User',
          bio: 'System administrator',
        },
      },
      preferences: {
        create: {
          preferredGenres: JSON.stringify(['All']),
          preferredArtists: JSON.stringify([]),
          preferredMoods: JSON.stringify(['Any', 'chill']),
          preferredLanguages: JSON.stringify(['English']),
          explicitContentPreference: false,
          autoplay: true,
          audioQuality: 'high',
        },
      },
    },
  })

  console.log(`Created admin user: ${adminUser.email}`)

  let sampleArtist = await prisma.artist.findFirst({ where: { name: 'Sample Artist' } });
  if (!sampleArtist) {
    sampleArtist = await prisma.artist.create({
      data: {
        name: 'Sample Artist',
        bio: 'A sample artist for demonstration',
        genres: JSON.stringify(['Pop', 'Electronic']),
      },
    });
    console.log(`Created sample artist: ${sampleArtist.name}`);
  } else {
    console.log(`Found sample artist: ${sampleArtist.name}`);
  }

  let sampleAlbum = await prisma.album.findFirst({ where: { title: 'Sample Album', artistId: sampleArtist.id } });
  if (!sampleAlbum) {
    sampleAlbum = await prisma.album.create({
      data: {
        title: 'Sample Album',
        artistId: sampleArtist.id,
        releaseDate: new Date(),
        albumType: 'ALBUM',
      },
    });
    console.log(`Created sample album: ${sampleAlbum.title}`);
  } else {
    console.log(`Found sample album: ${sampleAlbum.title}`);
  }

  let sampleTrack = await prisma.track.findFirst({ where: { title: 'Sample Track', albumId: sampleAlbum.id } });
  if (!sampleTrack) {
    sampleTrack = await prisma.track.create({
      data: {
        title: 'Sample Track',
        albumId: sampleAlbum.id,
        duration: 240,
        trackNumber: 1,
        genre: 'Pop',
        language: 'English',
        releaseDate: new Date(),
        energy: 0.8,
        valence: 0.7,
        danceability: 0.75,
        acousticness: 0.2,
        instrumentalness: 0.1,
        speechiness: 0.05,
        tempo: 120,
        mood: JSON.stringify(['Happy', 'Energetic', 'chill']),
      },
    });
    console.log(`Created sample track: ${sampleTrack.title}`);

    // Link the track to the artist (via TrackArtist)
    await prisma.trackArtist.create({
      data: {
        trackId: sampleTrack.id,
        artistId: sampleArtist.id,
      },
    });
    console.log('Linked track to artist');
  } else {
    console.log(`Found sample track: ${sampleTrack.title}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
