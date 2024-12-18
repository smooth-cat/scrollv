import { macro } from "../util";

describe('macro', () => {
  it('hello', ()=> {
    const spy = jest.fn()
    macro(() => {
      spy();
    });
    setTimeout(() => {
      expect(spy).toHaveBeenCalled();
    })
  })
})