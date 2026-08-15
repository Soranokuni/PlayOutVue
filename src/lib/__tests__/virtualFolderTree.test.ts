import { describe, it, expect } from 'vitest';
import { buildVirtualFolderTree, type LibraryAsset } from '../../stores/mediaLibrary';
import { buildGreekAdvisoryText, GREEK_COMPLIANCE_PRESETS } from '../greekCompliance';

const createMockAsset = (uuid: string, name: string, virtualFolder: string): LibraryAsset => ({
  uuid,
  display_name: name,
  virtual_folder: virtualFolder,
  current_path: `C:/Media/${name}.mp4`,
  duration_ms: 60000,
  trim_in_ms: 0,
  trim_out_ms: 60000,
  rating: 'K',
  status: 'ready',
});

describe('Virtual Folder Tree Engine', () => {
  it('builds a hierarchical tree from nested asset paths', () => {
    const assets: LibraryAsset[] = [
      createMockAsset('1', 'Root Movie', '/'),
      createMockAsset('2', 'Show 1 Pilot', '/Shows/Show 1'),
      createMockAsset('3', 'Show 1 Ep 2', '/Shows/Show 1'),
      createMockAsset('4', 'Season 2 Ep 1', '/Shows/Show 1/Season 2'),
      createMockAsset('5', 'Nature Doc', '/Documentaries'),
    ];

    const tree = buildVirtualFolderTree(assets);

    expect(tree.path).toBe('/');
    expect(tree.name).toBe('All Media (Root)');
    expect(tree.directAssets).toHaveLength(1);
    expect(tree.directAssets[0]!.display_name).toBe('Root Movie');
    expect(tree.allAssetCount).toBe(5);

    // Children of Root: Documentaries and Shows
    expect(tree.children).toHaveLength(2);
    const docNode = tree.children.find((c) => c.name === 'Documentaries');
    const showsNode = tree.children.find((c) => c.name === 'Shows');

    expect(docNode).toBeDefined();
    expect(docNode!.path).toBe('/Documentaries');
    expect(docNode!.depth).toBe(1);
    expect(docNode!.directAssets).toHaveLength(1);
    expect(docNode!.allAssetCount).toBe(1);

    expect(showsNode).toBeDefined();
    expect(showsNode!.path).toBe('/Shows');
    expect(showsNode!.depth).toBe(1);
    expect(showsNode!.directAssets).toHaveLength(0); // Intermediate folder
    expect(showsNode!.allAssetCount).toBe(3);

    // Subfolder of Shows: Show 1
    expect(showsNode!.children).toHaveLength(1);
    const show1Node = showsNode!.children[0]!;
    expect(show1Node.path).toBe('/Shows/Show 1');
    expect(show1Node.depth).toBe(2);
    expect(show1Node.directAssets).toHaveLength(2);
    expect(show1Node.allAssetCount).toBe(3);

    // Subfolder of Show 1: Season 2
    expect(show1Node.children).toHaveLength(1);
    const season2Node = show1Node.children[0]!;
    expect(season2Node.path).toBe('/Shows/Show 1/Season 2');
    expect(season2Node.depth).toBe(3);
    expect(season2Node.directAssets).toHaveLength(1);
    expect(season2Node.allAssetCount).toBe(1);
  });

  it('includes empty transient folders in the hierarchy', () => {
    const assets: LibraryAsset[] = [
      createMockAsset('1', 'News Intro', '/News'),
    ];
    const transientFolders = {
      '/Shows/Drama/Upcoming': '/',
      '/Archived': '/',
    };

    const tree = buildVirtualFolderTree(assets, transientFolders);

    expect(tree.children.some((c) => c.path === '/News')).toBe(true);
    expect(tree.children.some((c) => c.path === '/Archived')).toBe(true);

    const shows = tree.children.find((c) => c.path === '/Shows');
    expect(shows).toBeDefined();
    const drama = shows!.children.find((c) => c.path === '/Shows/Drama');
    expect(drama).toBeDefined();
    const upcoming = drama!.children.find((c) => c.path === '/Shows/Drama/Upcoming');
    expect(upcoming).toBeDefined();
    expect(upcoming!.depth).toBe(3);
  });

  it('applies folder colors properly to nested nodes', () => {
    const assets: LibraryAsset[] = [
      createMockAsset('1', 'Clip', '/Shows/Special'),
    ];
    const folderColors = {
      '/Shows': '#e63946',
      '/Shows/Special': '#2a9d8f',
    };

    const tree = buildVirtualFolderTree(assets, {}, folderColors);
    const shows = tree.children.find((c) => c.path === '/Shows')!;
    const special = shows.children.find((c) => c.path === '/Shows/Special')!;

    expect(shows.color).toBe('#e63946');
    expect(special.color).toBe('#2a9d8f');
  });

  it('filters assets correctly while preserving folder ancestry when searching', () => {
    const assets: LibraryAsset[] = [
      createMockAsset('1', 'Breaking News Alpha', '/News/Daily'),
      createMockAsset('2', 'Sports Report', '/News/Sports'),
      createMockAsset('3', 'Evening Movie', '/Movies'),
    ];

    const tree = buildVirtualFolderTree(assets, {}, {}, [], 'alpha');

    expect(tree.allAssetCount).toBe(1);
    const news = tree.children.find((c) => c.path === '/News')!;
    expect(news).toBeDefined();
    expect(news.allAssetCount).toBe(1);
    const daily = news.children.find((c) => c.path === '/News/Daily')!;
    expect(daily).toBeDefined();
    expect(daily.directAssets).toHaveLength(1);
    expect(daily.directAssets[0]!.display_name).toBe('Breaking News Alpha');
  });
});

describe('Greek Compliance Helpers & Presets', () => {
  it('generates grammatical Greek advisory text for single descriptor', () => {
    const violenceText = buildGreekAdvisoryText(['violence'], 'movie');
    expect(violenceText).toBe('ΑΥΤΗ Η ΤΑΙΝΙΑ ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ');

    const sexText = buildGreekAdvisoryText(['sex']);
    expect(sexText).toBe('ΠΕΡΙΕΧΕΙ ΣΕΞ');
  });

  it('generates combined Greek advisory text for multiple descriptors', () => {
    const combined = buildGreekAdvisoryText(['violence', 'sex', 'language'], 'movie');
    expect(combined).toBe('ΑΥΤΗ Η ΤΑΙΝΙΑ ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ, ΣΕΞ ΚΑΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ');
  });

  it('contains comprehensive presets for 12, 16, and 18 ratings', () => {
    const presets18 = GREEK_COMPLIANCE_PRESETS.filter((p) => p.ageRating === '18');
    expect(presets18.length).toBeGreaterThanOrEqual(10);

    const presets16 = GREEK_COMPLIANCE_PRESETS.filter((p) => p.ageRating === '16');
    expect(presets16.length).toBeGreaterThanOrEqual(8);

    const presets12 = GREEK_COMPLIANCE_PRESETS.filter((p) => p.ageRating === '12');
    expect(presets12.length).toBeGreaterThanOrEqual(6);
  });
});
