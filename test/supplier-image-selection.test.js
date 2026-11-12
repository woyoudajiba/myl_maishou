const test=require('node:test');
const assert=require('node:assert/strict');
const {selectSupplierImageIndices}=require('../desktop/buyer-providers');

test('supplier OCR samples cover the full detail-image range, including late size charts',()=>{
  const images=Array.from({length:24},(_,index)=>`https://img.example/${index}.jpg`);
  assert.deepEqual(selectSupplierImageIndices({images,imageGroups:{main:images.slice(0,4),details:images.slice(4)}},4),[4,10,17,23]);
});

test('supplier OCR falls back to main and color images when no detail gallery is available',()=>{
  const images=['main.jpg','color-a.jpg','color-b.jpg'];
  assert.deepEqual(selectSupplierImageIndices({images,imageGroups:{main:['main.jpg'],colors:['color-a.jpg','color-b.jpg']}},4),[0,1,2]);
});
