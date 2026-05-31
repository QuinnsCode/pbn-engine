use std::collections::HashSet;

#[derive(Clone)]
struct BoundingBox {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
}

impl BoundingBox {
    fn new() -> Self {
        BoundingBox { min_x: i32::MAX, min_y: i32::MAX, max_x: i32::MIN, max_y: i32::MIN }
    }
}

#[derive(Clone)]
struct Facet {
    id: u32,
    color: u8,
    point_count: u32,
    border_points: Vec<i32>,
    neighbour_facets: Option<Vec<u32>>,
    neighbour_facets_is_dirty: bool,
    bbox: BoundingBox,
}

impl Facet {
    fn new(id: u32, color: u8) -> Self {
        Facet { id, color, point_count: 0, border_points: Vec::new(),
                neighbour_facets: None, neighbour_facets_is_dirty: true, bbox: BoundingBox::new() }
    }
    fn border_point_count(&self) -> usize { self.border_points.len() / 2 }
    fn border_point_x(&self, i: usize) -> i32 { self.border_points[i * 2] }
    fn border_point_y(&self, i: usize) -> i32 { self.border_points[i * 2 + 1] }
}

// Safe facet_map read — checks x,y bounds AND array length
#[inline]
fn fm_get(facet_map: &[u32], x: i32, y: i32, w: i32, h: i32) -> Option<u32> {
    if x < 0 || y < 0 || x >= w || y >= h { return None; }
    let idx = (y * w + x) as usize;
    facet_map.get(idx).copied()
}

// Safe visited/img check — checks bounds then reads
#[inline]
fn is_blocked(vx: i32, vy: i32, w: i32, h: i32, visited: &[bool], img: &[u8], color: u8) -> bool {
    if vx < 0 || vy < 0 || vx >= w || vy >= h { return true; }
    let idx = (vy * w + vx) as usize;
    match (visited.get(idx), img.get(idx)) {
        (Some(&v), Some(&c)) => v || c != color,
        _ => true,
    }
}

// Safe inner point check — uses get() for all accesses
#[inline]
fn match_all_around(img: &[u8], x: i32, y: i32, w: i32, h: i32, color: u8) -> bool {
    let idx = (y * w + x) as usize;
    let wu = w as usize;
    let left  = if x > 0      { img.get(idx - 1)   } else { None };
    let up    = if y > 0      { img.get(idx - wu)   } else { None };
    let right = if x + 1 < w  { img.get(idx + 1)   } else { None };
    let down  = if y + 1 < h  { img.get(idx + wu)  } else { None };
    matches!(left, Some(&c) if c == color) &&
    matches!(up,   Some(&c) if c == color) &&
    matches!(right,Some(&c) if c == color) &&
    matches!(down, Some(&c) if c == color)
}

// Safe pixel visit — checks bounds before every write
#[inline]
fn visit_pixel(
    x: i32, y: i32, w: i32, h: i32,
    visited: &mut [bool], facet_map: &mut [u32], img: &[u8],
    facet_index: u32, facet_color: u8, facet: &mut Facet,
) {
    if x < 0 || y < 0 || x >= w || y >= h { return; }
    let idx = (y * w + x) as usize;
    if idx >= visited.len() || idx >= facet_map.len() { return; }
    visited[idx] = true;
    facet_map[idx] = facet_index;
    facet.point_count += 1;
    if !match_all_around(img, x, y, w, h, facet_color) {
        facet.border_points.push(x);
        facet.border_points.push(y);
    }
    if x < facet.bbox.min_x { facet.bbox.min_x = x; }
    if x > facet.bbox.max_x { facet.bbox.max_x = x; }
    if y < facet.bbox.min_y { facet.bbox.min_y = y; }
    if y > facet.bbox.max_y { facet.bbox.max_y = y; }
}

// Iterative flood fill — no recursion, no stack overflow
fn flood_fill(
    start_x: i32, start_y: i32,
    w: i32, h: i32,
    img: &[u8], facet_map: &mut [u32],
    facet_index: u32, facet_color: u8,
    visited: &mut [bool], facet: &mut Facet,
) {
    let mut stack: Vec<(i32, i32)> = vec![(start_x, start_y)];

    while let Some((sx, sy)) = stack.pop() {
        // Move upper-left from seed
        let mut xx = sx; let mut yy = sy;
        loop {
            let ox = xx; let oy = yy;
            while yy > 0 && !is_blocked(xx, yy-1, w, h, visited, img, facet_color) { yy -= 1; }
            while xx > 0 && !is_blocked(xx-1, yy, w, h, visited, img, facet_color) { xx -= 1; }
            if xx == ox && yy == oy { break; }
        }

        let mut x = xx; let mut y = yy;
        let mut last_row_length: i32 = 0;

        loop {
            let mut row_length: i32 = 0;
            let mut scan_x = x;

            if last_row_length != 0 && is_blocked(x, y, w, h, visited, img, facet_color) {
                loop {
                    last_row_length -= 1;
                    if last_row_length == 0 { break; }
                    x += 1;
                    if !is_blocked(x, y, w, h, visited, img, facet_color) { break; }
                }
                if last_row_length == 0 { break; }
                scan_x = x;
            } else {
                while x > 0 && !is_blocked(x-1, y, w, h, visited, img, facet_color) {
                    x -= 1;
                    visit_pixel(x, y, w, h, visited, facet_map, img, facet_index, facet_color, facet);
                    row_length += 1; last_row_length += 1;
                    if y > 0 && !is_blocked(x, y-1, w, h, visited, img, facet_color) {
                        stack.push((x, y-1));
                    }
                }
            }

            while scan_x < w && !is_blocked(scan_x, y, w, h, visited, img, facet_color) {
                visit_pixel(scan_x, y, w, h, visited, facet_map, img, facet_index, facet_color, facet);
                row_length += 1; scan_x += 1;
            }

            if row_length < last_row_length {
                let end = x + last_row_length;
                let mut tsx = scan_x + 1;
                while tsx < end {
                    if !is_blocked(tsx, y, w, h, visited, img, facet_color) { stack.push((tsx, y)); }
                    tsx += 1;
                }
            } else if row_length > last_row_length && y > 0 {
                let mut ux = x + last_row_length + 1;
                while ux < scan_x {
                    if !is_blocked(ux, y-1, w, h, visited, img, facet_color) { stack.push((ux, y-1)); }
                    ux += 1;
                }
            }

            last_row_length = row_length;
            y += 1;
            if last_row_length == 0 || y >= h { break; }
        }
    }
}

fn build_facet(
    facet_index: u32, facet_color: u8, x: i32, y: i32,
    visited: &mut [bool], img: &[u8], facet_map: &mut [u32],
    width: u32, height: u32,
) -> Facet {
    let mut facet = Facet::new(facet_index, facet_color);
    flood_fill(x, y, width as i32, height as i32, img, facet_map, facet_index, facet_color, visited, &mut facet);
    facet
}

// All facet_map accesses go through fm_get — no direct [] indexing
fn build_facet_neighbour(facet: &mut Facet, facet_map: &[u32], width: u32, height: u32) {
    let mut unique: HashSet<u32> = HashSet::new();
    let fid = facet.id;
    let w = width as i32; let h = height as i32;
    let bp_count = facet.border_point_count();
    for i in 0..bp_count {
        let px = facet.border_point_x(i);
        let py = facet.border_point_y(i);
        if let Some(id) = fm_get(facet_map, px-1, py, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px, py-1, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px+1, py, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px, py+1, w, h) { if id != fid { unique.insert(id); } }
    }
    facet.neighbour_facets = Some(unique.into_iter().collect());
    facet.neighbour_facets_is_dirty = false;
}

fn ensure_neighbours_built(facet_id: u32, facets: &mut Vec<Option<Facet>>, facet_map: &[u32], width: u32, height: u32) {
    let dirty = facets.get(facet_id as usize).and_then(|f| f.as_ref()).map(|f| f.neighbour_facets_is_dirty).unwrap_or(false);
    if dirty {
        let fm = facet_map.to_vec();
        if let Some(Some(ref mut f)) = facets.get_mut(facet_id as usize) {
            build_facet_neighbour(f, &fm, width, height);
        }
    }
}

fn get_closest_neighbour_for_pixel(
    facet_id: u32, facets: &mut Vec<Option<Facet>>,
    x: i32, y: i32, color_distances: &[f64], n_colors: u32,
    facet_map: &[u32], width: u32, height: u32,
) -> i32 {
    ensure_neighbours_built(facet_id, facets, facet_map, width, height);
    let (neighbours, facet_color) = match facets.get(facet_id as usize).and_then(|f| f.as_ref()) {
        Some(f) => (f.neighbour_facets.clone().unwrap_or_default(), f.color),
        None => return -1,
    };
    let mut closest = -1i32;
    let mut min_dist = i32::MAX;
    let mut min_color_dist = f64::MAX;
    for &n_idx in &neighbours {
        let (n_color, bpts, bp_count) = match facets.get(n_idx as usize).and_then(|f| f.as_ref()) {
            Some(n) if n.border_point_count() > 0 => (n.color, n.border_points.clone(), n.border_point_count()),
            _ => continue,
        };
        for i in 0..bp_count {
            let bx = bpts[i * 2]; let by = bpts[i * 2 + 1];
            let dist = (bx - x).abs() + (by - y).abs();
            if dist < min_dist {
                min_dist = dist; closest = n_idx as i32; min_color_dist = f64::MAX;
            } else if dist == min_dist {
                let cd_idx = (facet_color as u32 * n_colors + n_color as u32) as usize;
                if let Some(&cd) = color_distances.get(cd_idx) {
                    if cd < min_color_dist { min_color_dist = cd; closest = n_idx as i32; }
                }
            }
        }
    }
    closest
}

fn rebuild_changed_neighbour_facets(
    facet_id: u32, facets: &mut Vec<Option<Facet>>,
    img: &mut Vec<u8>, facet_map: &mut Vec<u32>,
    visited_cache: &mut Vec<bool>, width: u32, height: u32,
) {
    ensure_neighbours_built(facet_id, facets, facet_map, width, height);
    let neighbours: Vec<u32> = facets.get(facet_id as usize)
        .and_then(|f| f.as_ref()).and_then(|f| f.neighbour_facets.clone()).unwrap_or_default();
    let mut changed_set: HashSet<u32> = HashSet::new();

    for &n_idx in &neighbours {
        if facets.get(n_idx as usize).and_then(|f| f.as_ref()).is_none() { continue; }
        changed_set.insert(n_idx);
        ensure_neighbours_built(n_idx, facets, facet_map, width, height);
        let nn = facets.get(n_idx as usize).and_then(|f| f.as_ref())
            .and_then(|f| f.neighbour_facets.clone()).unwrap_or_default();
        for &nn_idx in &nn { changed_set.insert(nn_idx); }

        // clear visited cache
        let bbox = match facets.get(n_idx as usize).and_then(|f| f.as_ref()) {
            Some(n) => n.bbox.clone(), None => continue,
        };
        for cy in bbox.min_y..=bbox.max_y {
            for cx in bbox.min_x..=bbox.max_x {
                let idx = (cy * width as i32 + cx) as usize;
                if idx < facet_map.len() && facet_map[idx] == n_idx { visited_cache[idx] = false; }
            }
        }

        // get seed — skip if no border points
        let (seed_x, seed_y, color) = match facets.get(n_idx as usize).and_then(|f| f.as_ref()) {
            Some(n) if n.border_point_count() > 0 => (n.border_point_x(0), n.border_point_y(0), n.color),
            _ => continue,
        };

        let new_facet = build_facet(n_idx, color, seed_x, seed_y, visited_cache, img, facet_map, width, height);
        if n_idx as usize >= facets.len() { continue; }
        if new_facet.point_count == 0 { facets[n_idx as usize] = None; }
        else { facets[n_idx as usize] = Some(new_facet); }
    }

    for &idx in &changed_set {
        if let Some(Some(ref mut f)) = facets.get_mut(idx as usize) {
            f.neighbour_facets = None; f.neighbour_facets_is_dirty = true;
        }
    }
}

fn rebuild_for_facet_change(
    facet_id: u32, facets: &mut Vec<Option<Facet>>,
    img: &mut Vec<u8>, facet_map: &mut Vec<u32>,
    visited_cache: &mut Vec<bool>, width: u32, height: u32,
) {
    rebuild_changed_neighbour_facets(facet_id, facets, img, facet_map, visited_cache, width, height);
    let bbox = match facets.get(facet_id as usize).and_then(|f| f.as_ref()) {
        Some(f) => f.bbox.clone(), None => return,
    };
    let w = width as i32; let h = height as i32;
    let mut needs_rebuild = false;
    for cy in bbox.min_y..=bbox.max_y {
        for cx in bbox.min_x..=bbox.max_x {
            let idx = (cy * w + cx) as usize;
            if idx >= facet_map.len() { continue; }
            if facet_map[idx] != facet_id { continue; }
            needs_rebuild = true;
            for (dx, dy) in [(-1i32,0i32),(0,-1),(1,0),(0,1)] {
                let nx = cx+dx; let ny = cy+dy;
                if nx < 0 || ny < 0 || nx >= w || ny >= h { continue; }
                let nidx = (ny * w + nx) as usize;
                if nidx >= facet_map.len() { continue; }
                let nfid = facet_map[nidx];
                if nfid == facet_id { continue; }
                if let Some(Some(ref n)) = facets.get(nfid as usize) {
                    img[idx] = n.color; break;
                }
            }
        }
    }
    if needs_rebuild {
        rebuild_changed_neighbour_facets(facet_id, facets, img, facet_map, visited_cache, width, height);
    }
}

fn delete_facet(
    facet_id: u32, facets: &mut Vec<Option<Facet>>,
    img: &mut Vec<u8>, facet_map: &mut Vec<u32>,
    color_distances: &[f64], n_colors: u32,
    visited_cache: &mut Vec<bool>, width: u32, height: u32,
) {
    if facets.get(facet_id as usize).and_then(|f| f.as_ref()).is_none() { return; }
    ensure_neighbours_built(facet_id, facets, facet_map, width, height);
    let has_neighbours = facets.get(facet_id as usize).and_then(|f| f.as_ref())
        .and_then(|f| f.neighbour_facets.as_ref()).map(|n| !n.is_empty()).unwrap_or(false);
    if !has_neighbours { facets[facet_id as usize] = None; return; }

    let bbox = match facets.get(facet_id as usize).and_then(|f| f.as_ref()) {
        Some(f) => f.bbox.clone(),
        None => return,
    };
    for j in bbox.min_y..=bbox.max_y {
        for i in bbox.min_x..=bbox.max_x {
            let idx = (j * width as i32 + i) as usize;
            if idx < facet_map.len() && facet_map[idx] == facet_id {
                let closest = get_closest_neighbour_for_pixel(
                    facet_id, facets, i, j, color_distances, n_colors, facet_map, width, height);
                if closest >= 0 {
                    if let Some(Some(ref n)) = facets.get(closest as usize) {
                        img[idx] = n.color;
                    }
                }
            }
        }
    }
    rebuild_for_facet_change(facet_id, facets, img, facet_map, visited_cache, width, height);
    facets[facet_id as usize] = None;
}

fn get_facets(img: &mut Vec<u8>, facet_map: &mut Vec<u32>, width: u32, height: u32) -> Vec<Option<Facet>> {
    let size = (width * height) as usize;
    let mut visited = vec![false; size];
    let mut facets: Vec<Option<Facet>> = Vec::new();
    for j in 0..height as i32 {
        for i in 0..width as i32 {
            let idx = (j * width as i32 + i) as usize;
            if !visited[idx] {
                let color = img[idx];
                let facet_index = facets.len() as u32;
                let facet = build_facet(facet_index, color, i, j, &mut visited, img, facet_map, width, height);
                facets.push(Some(facet));
            }
        }
    }
    let fm = facet_map.clone();
    for f in facets.iter_mut() {
        if let Some(ref mut facet) = f { build_facet_neighbour(facet, &fm, width, height); }
    }
    facets
}

fn reduce_facets_internal(
    img: &mut Vec<u8>, facet_map: &mut Vec<u32>,
    width: u32, height: u32, smaller_than: u32, maximum_facets: u32,
    remove_large_to_small: bool, color_distances: &[f64], n_colors: u32,
) {
    let mut facets = get_facets(img, facet_map, width, height);
    let size = (width * height) as usize;
    let mut visited_cache = vec![false; size];

    let mut processing_order: Vec<u32> = facets.iter().filter_map(|f| f.as_ref().map(|f| f.id)).collect();
    processing_order.sort_by(|&a, &b| {
        let pa = facets.get(a as usize).and_then(|f| f.as_ref()).map(|f| f.point_count).unwrap_or(0);
        let pb = facets.get(b as usize).and_then(|f| f.as_ref()).map(|f| f.point_count).unwrap_or(0);
        pb.cmp(&pa)
    });
    if !remove_large_to_small { processing_order.reverse(); }

    for &fid in &processing_order {
        let should = facets.get(fid as usize).and_then(|f| f.as_ref()).map(|f| f.point_count < smaller_than).unwrap_or(false);
        if should { delete_facet(fid, &mut facets, img, facet_map, color_distances, n_colors, &mut visited_cache, width, height); }
    }

    let mut facet_count = facets.iter().filter(|f| f.is_some()).count();
    while facet_count > maximum_facets as usize {
        let mut min_count = u32::MAX; let mut min_id = u32::MAX;
        for (i, f) in facets.iter().enumerate() {
            if let Some(ref facet) = f {
                if facet.point_count < min_count { min_count = facet.point_count; min_id = i as u32; }
            }
        }
        if min_id == u32::MAX { break; }
        delete_facet(min_id, &mut facets, img, facet_map, color_distances, n_colors, &mut visited_cache, width, height);
        facet_count = facets.iter().filter(|f| f.is_some()).count();
    }
}

#[no_mangle]
pub extern "C" fn reduce_facets(
    img_ptr: *mut u8, facet_map_ptr: *mut u32,
    width: u32, height: u32, smaller_than: u32, maximum_facets: u32,
    remove_large_to_small: u32, color_dist_ptr: *const f64, n_colors: u32,
) {
    let size = (width * height) as usize;
    let mut img: Vec<u8> = unsafe { std::slice::from_raw_parts(img_ptr, size).to_vec() };
    let mut fmap: Vec<u32> = unsafe { std::slice::from_raw_parts(facet_map_ptr, size).to_vec() };
    let color_distances: Vec<f64> = unsafe { std::slice::from_raw_parts(color_dist_ptr, (n_colors * n_colors) as usize).to_vec() };
    reduce_facets_internal(&mut img, &mut fmap, width, height, smaller_than, maximum_facets, remove_large_to_small != 0, &color_distances, n_colors);
    unsafe {
        std::ptr::copy_nonoverlapping(img.as_ptr(), img_ptr, size);
        std::ptr::copy_nonoverlapping(fmap.as_ptr(), facet_map_ptr, size);
    }
}

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }